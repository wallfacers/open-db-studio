import type { JsonPatchOp } from './types'

/**
 * Apply RFC 6902 JSON Patch operations with atomic semantics.
 * Extension: paths may use [key=value] syntax for array element addressing.
 * Throws on any error; original is never mutated.
 */
export function applyPatch<T>(doc: T, ops: JsonPatchOp[]): T {
  let result = structuredClone(doc)

  for (const op of ops) {
    switch (op.op) {
      case 'add':
        result = applyAdd(result, resolvePath(result, op.path), op.value)
        break
      case 'remove':
        result = applyRemove(result, resolvePath(result, op.path))
        break
      case 'replace':
        result = applyReplace(result, resolvePath(result, op.path), op.value)
        break
      case 'move': {
        const fromPath = resolvePath(result, op.from!)
        const value = getByPath(result, fromPath)
        result = applyRemove(result, fromPath)
        result = applyAdd(result, resolvePath(result, op.path), value)
        break
      }
      case 'copy': {
        const value = getByPath(result, resolvePath(result, op.from!))
        result = applyAdd(result, resolvePath(result, op.path), structuredClone(value))
        break
      }
      default:
        throw new Error(`Unknown patch op: ${(op as any).op}`)
    }
  }

  return result
}

function resolvePath(doc: any, path: string): string {
  const raw = path.replace(/^\//, '').split('/')
  const resolved: string[] = []

  let current = doc
  for (const token of raw) {
    const match = token.match(/^([^[]+)\[(\w+)=([^\]]+)\]$/)
    if (match) {
      const [, arrayField, key, value] = match
      resolved.push(arrayField)
      const arr = current[arrayField]
      if (!Array.isArray(arr)) throw new Error(`Path segment '${arrayField}' is not an array`)
      const idx = arr.findIndex((item: any) => String(item[key]) === value)
      if (idx === -1) throw new Error(`No element with ${key}=${value} in ${arrayField}`)
      resolved.push(String(idx))
      current = arr[idx]
    } else {
      resolved.push(token)
      if (current != null && typeof current === 'object') {
        current = Array.isArray(current) ? current[Number(token)] : current[token]
      }
    }
  }

  return '/' + resolved.join('/')
}

function parsePointer(path: string): string[] {
  if (path === '' || path === '/') return []
  return path.replace(/^\//, '').split('/').map(t => t.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function getByPath(doc: any, path: string): any {
  const tokens = parsePointer(path)
  let current = doc
  for (const t of tokens) {
    if (current == null) throw new Error(`Path not found: ${path}`)
    current = Array.isArray(current) ? current[Number(t)] : current[t]
  }
  return current
}

function getParentAndKey(doc: any, path: string): [any, string] {
  const tokens = parsePointer(path)
  if (tokens.length === 0) throw new Error('Cannot operate on root')
  const key = tokens.pop()!
  let current = doc
  for (const t of tokens) {
    if (current == null) throw new Error(`Path not found: ${path}`)
    current = Array.isArray(current) ? current[Number(t)] : current[t]
  }
  if (current == null) throw new Error(`Parent not found for: ${path}`)
  return [current, key]
}

function applyAdd<T>(doc: T, path: string, value: any): T {
  const [parent, key] = getParentAndKey(doc, path)
  if (Array.isArray(parent)) {
    if (key === '-') {
      parent.push(structuredClone(value))
    } else {
      const idx = Number(key)
      if (idx < 0 || idx > parent.length) throw new Error(`Array index out of bounds: ${idx}`)
      parent.splice(idx, 0, structuredClone(value))
    }
  } else {
    parent[key] = structuredClone(value)
  }
  return doc
}

function applyRemove<T>(doc: T, path: string): T {
  const [parent, key] = getParentAndKey(doc, path)
  if (Array.isArray(parent)) {
    const idx = Number(key)
    if (idx < 0 || idx >= parent.length) throw new Error(`Array index out of bounds: ${idx}`)
    parent.splice(idx, 1)
  } else {
    if (!(key in parent)) throw new Error(`Property not found: ${key}`)
    delete parent[key]
  }
  return doc
}

function applyReplace<T>(doc: T, path: string, value: any): T {
  const [parent, key] = getParentAndKey(doc, path)
  if (Array.isArray(parent)) {
    const idx = Number(key)
    if (idx < 0 || idx >= parent.length) throw new Error(`Array index out of bounds: ${idx}`)
    parent[idx] = structuredClone(value)
  } else {
    if (!(key in parent)) throw new Error(`Property not found: ${key}`)
    parent[key] = structuredClone(value)
  }
  return doc
}
