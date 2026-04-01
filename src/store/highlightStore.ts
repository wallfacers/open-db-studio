import { create } from 'zustand'

export interface HighlightEntry {
  path: string
  phase: 'pulse' | 'residual'
  timestamp: number
}

const PULSE_DURATION = 2400 // ms — matches CSS animation duration

interface HighlightState {
  /** key = scopeId (e.g. tabId), value = highlight entries for that scope */
  highlights: Map<string, HighlightEntry[]>

  /** Add highlight entries in 'pulse' phase. Auto-promotes to 'residual' after PULSE_DURATION. */
  addHighlights: (scopeId: string, paths: string[]) => void

  /** Get the phase for a specific field path within a scope. Returns null if not highlighted. */
  getPhase: (scopeId: string, path: string) => 'pulse' | 'residual' | null

  /** Clear a single field's highlight (called when user edits the field). */
  clearHighlight: (scopeId: string, path: string) => void

  /** Clear all highlights for a scope (called when tab closes). */
  clearAll: (scopeId: string) => void
}

export const useHighlightStore = create<HighlightState>((set, get) => ({
  highlights: new Map(),

  addHighlights: (scopeId, paths) => {
    const now = Date.now()
    const entries: HighlightEntry[] = paths.map(p => ({
      path: p,
      phase: 'pulse' as const,
      timestamp: now,
    }))

    set(state => {
      const next = new Map(state.highlights)
      // Merge with existing (replace entries for same paths)
      const existing = (next.get(scopeId) ?? []).filter(
        e => !paths.includes(e.path)
      )
      next.set(scopeId, [...existing, ...entries])
      return { highlights: next }
    })

    // Auto-promote to residual after pulse duration
    setTimeout(() => {
      set(state => {
        const next = new Map(state.highlights)
        const list = next.get(scopeId)
        if (!list) return state
        const updated = list.map(e =>
          e.timestamp === now && e.phase === 'pulse'
            ? { ...e, phase: 'residual' as const }
            : e
        )
        next.set(scopeId, updated)
        return { highlights: next }
      })
    }, PULSE_DURATION)
  },

  getPhase: (scopeId, path) => {
    const list = get().highlights.get(scopeId)
    if (!list) return null
    // Wildcard: if '*' exists, all fields are highlighted
    const wildcard = list.find(e => e.path === '*')
    if (wildcard) return wildcard.phase
    const entry = list.find(e => e.path === path)
    return entry?.phase ?? null
  },

  clearHighlight: (scopeId, path) => {
    set(state => {
      const next = new Map(state.highlights)
      const list = next.get(scopeId)
      if (!list) return state
      next.set(scopeId, list.filter(e => e.path !== path))
      return { highlights: next }
    })
  },

  clearAll: (scopeId) => {
    set(state => {
      const next = new Map(state.highlights)
      next.delete(scopeId)
      return { highlights: next }
    })
  },
}))
