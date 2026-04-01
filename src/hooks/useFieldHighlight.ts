import { useCallback } from 'react'
import { useHighlightStore } from '../store/highlightStore'

/**
 * Generic hook for form field highlight.
 * Returns a CSS class name based on the current highlight phase,
 * and a callback to clear the highlight when the user edits the field.
 *
 * Usage:
 *   const { className, onUserEdit } = useFieldHighlight(tabId, 'env.parallelism')
 *   <div className={className}>
 *     <input onChange={(e) => { onUserEdit(); handle(e) }} />
 *   </div>
 */
export function useFieldHighlight(scopeId: string, path: string) {
  const phase = useHighlightStore(s => {
    const list = s.highlights.get(scopeId)
    if (!list) return null
    const wildcard = list.find(e => e.path === '*')
    if (wildcard) return wildcard.phase
    return list.find(e => e.path === path)?.phase ?? null
  })
  const clearHighlight = useHighlightStore(s => s.clearHighlight)

  const className =
    phase === 'pulse'
      ? 'ai-highlight-pulse'
      : phase === 'residual'
        ? 'ai-highlight-residual'
        : ''

  const onUserEdit = useCallback(() => {
    clearHighlight(scopeId, path)
  }, [clearHighlight, scopeId, path])

  return { phase, className, onUserEdit }
}
