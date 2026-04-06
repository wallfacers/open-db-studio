/**
 * Shared batch utilities for MCP UI adapters.
 */

import type { ExecResult } from './types'
import { execError } from './errors'

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
 * Recursively checks all nested strings (matching resolveVarRefs behavior).
 * Returns an array of error strings (empty if valid).
 */
export function validateBatchVarRefs(
  ops: Array<{ action: string; params?: unknown }>,
): string[] {
  const errors: string[] = []
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    const collectErrors = (path: string, val: unknown) => {
      if (typeof val === 'string') {
        const m = val.match(/^\$(\d+)/)
        if (m) {
          const refIdx = parseInt(m[1], 10)
          if (refIdx >= i) {
            errors.push(`op[${i}] ${op.action}: ${path} references $${refIdx} which is not a prior op (forward reference)`)
          }
          if (refIdx >= ops.length) {
            errors.push(`op[${i}] ${op.action}: ${path} references $${refIdx} but only ${ops.length} ops exist`)
          }
        }
      } else if (Array.isArray(val)) {
        val.forEach((v, j) => collectErrors(`${path}[${j}]`, v))
      } else if (val !== null && typeof val === 'object') {
        for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
          collectErrors(`${path}.${k}`, v)
        }
      }
    }
    if (op.params != null) {
      collectErrors('params', op.params)
    }
  }
  return errors
}

/**
 * Validate batch ops without executing (dry-run).
 * Checks action names, required params, nested batch, and variable refs.
 */
export function validateBatchOps(
  ops: Array<{ action: string; params?: unknown }>,
  actionDefs: Array<{ name: string; paramsSchema?: any }>,
): ExecResult {
  const actionNames = new Set(actionDefs.map(a => a.name))
  const errors: string[] = []

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (op.action === 'batch') {
      errors.push(`op[${i}]: nested batch is not allowed`)
      continue
    }
    if (!actionNames.has(op.action)) {
      errors.push(`op[${i}]: unknown action "${op.action}"`)
      continue
    }
    const def = actionDefs.find(a => a.name === op.action)
    if (def?.paramsSchema?.required && op.params && typeof op.params === 'object') {
      for (const key of def.paramsSchema.required) {
        const val = (op.params as Record<string, unknown>)[key]
        if (val === undefined) {
          errors.push(`op[${i}] ${op.action}: missing required param "${key}"`)
        }
      }
    }
  }

  errors.push(...validateBatchVarRefs(ops))

  if (errors.length > 0) {
    return { success: false, error: `Dry-run validation failed:\n${errors.join('\n')}` }
  }
  return { success: true, data: { validated: true, opCount: ops.length } }
}

export interface BatchExecOptions {
  dryRun?: boolean
  actionDefs?: Array<{ name: string; paramsSchema?: any }>
  /** Called when batch partially fails (some ops already committed). */
  onPartialFailure?: () => Promise<void>
  /** If true, appends current state to successful result. */
  returnState?: boolean
  readState?: () => unknown
}

/**
 * Execute a sequence of batch ops with variable binding.
 * Shared across all adapters to eliminate duplication.
 */
export async function executeBatch(
  params: any,
  execFn: (action: string, params?: any) => Promise<ExecResult>,
  options?: BatchExecOptions,
): Promise<ExecResult> {
  const ops: Array<{ action: string; params?: unknown }> = params?.ops ?? []
  if (ops.length === 0) return execError('ops array is required and must be non-empty')
  if (ops.length > 50) return execError('ops array too large (max 50)')

  if (params?.dryRun && options?.actionDefs) {
    return validateBatchOps(ops, options.actionDefs)
  }

  const results: unknown[] = []

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (op.action === 'batch') {
      return { success: false, error: `op[${i}]: nested batch is not allowed` }
    }

    let resolvedParams: unknown
    try {
      resolvedParams = resolveVarRefs(op.params, results)
    } catch (e) {
      if (i > 0) await options?.onPartialFailure?.()
      return {
        success: false,
        error: `op[${i}] ${op.action}: variable resolve failed — ${e instanceof Error ? e.message : String(e)}`,
        data: { completedOps: i, results, failedOp: { index: i, action: op.action, rawParams: op.params } },
      }
    }

    const result = await execFn(op.action, resolvedParams)
    if (!result.success) {
      if (i > 0) await options?.onPartialFailure?.()
      return {
        success: false,
        error: `op[${i}] ${op.action} failed: ${result.error}`,
        data: { completedOps: i, results, failedOp: { index: i, action: op.action, resolvedParams } },
      }
    }
    results.push(result.data ?? {})
  }

  const data: Record<string, unknown> = { results }
  if (options?.returnState && options.readState) {
    data.state = options.readState()
  }
  return { success: true, data }
}
