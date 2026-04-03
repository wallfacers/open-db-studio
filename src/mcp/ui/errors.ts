import type { PatchResult, ExecResult } from './types'

/**
 * Build a standardized PatchResult error.
 * Template: "<problem>. Expected: <correct usage>. Hint: <alternative>"
 */
export function patchError(
  problem: string,
  expected?: string,
  hint?: string,
): PatchResult {
  let message = problem
  if (expected) message += `. Expected: ${expected}`
  if (hint) message += `. Hint: ${hint}`
  return { status: 'error', message }
}

/**
 * Build a standardized ExecResult error.
 * Template: "<problem>. Hint: <alternative>"
 */
export function execError(
  problem: string,
  hint?: string,
): ExecResult {
  let message = problem
  if (hint) message += `. Hint: ${hint}`
  return { success: false, error: message }
}
