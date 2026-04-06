/**
 * Shared batch utilities for MCP UI adapters.
 * Extracted from ERCanvasAdapter to be reused by TableFormAdapter and others.
 */

// Matches "$0", "$1.tableId", "$2.columnIds[0]" etc.
const VAR_REF_RE = /^\$(\d+)(\..*)?$/

/**
 * Recursively resolve "$N.path" variable references in a value tree.
 * Each `$N` refers to `results[N]` — the output of a previous batch op.
 */
export function resolveVarRefs(value: unknown, results: unknown[]): unknown {
  if (typeof value === 'string') {
    const m = value.match(VAR_REF_RE)
    if (!m) return value
    const idx = Number(m[1])
    if (idx >= results.length) {
      throw new Error(`Variable $${idx} references op[${idx}] which hasn't executed yet (only ${results.length} results available)`)
    }
    let resolved: unknown = results[idx]
    if (m[2]) {
      const segments = m[2].slice(1).split('.')
      const walkedPath: string[] = [`$${idx}`]
      for (const seg of segments) {
        if (resolved == null) {
          throw new Error(`Variable ${walkedPath.join('.')}.${seg} failed: ${walkedPath.join('.')} is ${resolved === null ? 'null' : 'undefined'}`)
        }
        walkedPath.push(seg)
        const arrMatch = seg.match(/^(\w+)\[(\d+)\]$/)
        if (arrMatch) {
          resolved = (resolved as Record<string, unknown>)[arrMatch[1]]
          if (resolved == null) {
            throw new Error(`Variable ${walkedPath.join('.')} failed: property '${arrMatch[1]}' is ${resolved === null ? 'null' : 'undefined'}`)
          }
          resolved = (resolved as unknown[])?.[Number(arrMatch[2])]
        } else {
          resolved = (resolved as Record<string, unknown>)[seg]
        }
      }
      if (resolved === undefined) {
        throw new Error(`Variable ${m[0]} resolved to undefined (full path: ${walkedPath.join('.')})`)
      }
    }
    return resolved
  }
  if (Array.isArray(value)) {
    return value.map(v => resolveVarRefs(v, results))
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveVarRefs(v, results)
    }
    return out
  }
  return value
}

/**
 * Validate $N variable references in batch ops without executing them.
 * Returns an array of error strings (empty if valid).
 */
export function validateBatchVarRefs(
  ops: Array<{ action: string; params?: unknown }>,
): string[] {
  const errors: string[] = []
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (op.params && typeof op.params === 'object') {
      for (const [key, val] of Object.entries(op.params as Record<string, unknown>)) {
        if (typeof val === 'string') {
          const m = val.match(/^\$(\d+)/)
          if (m) {
            const refIdx = parseInt(m[1], 10)
            if (refIdx >= i) {
              errors.push(`op[${i}] ${op.action}: param "${key}" references $${refIdx} which is not a prior op (forward reference)`)
            }
            if (refIdx >= ops.length) {
              errors.push(`op[${i}] ${op.action}: param "${key}" references $${refIdx} but only ${ops.length} ops exist`)
            }
          }
        }
      }
    }
  }
  return errors
}
