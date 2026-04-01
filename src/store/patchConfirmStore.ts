import { create } from 'zustand'
import type { PendingPatch } from '../mcp/ui/types'

interface PatchConfirmState {
  pending: PendingPatch | null
  propose: (patch: PendingPatch) => void
  confirm: () => void
  reject: () => void
}

export const usePatchConfirmStore = create<PatchConfirmState>((set, get) => ({
  pending: null,

  propose: (patch) => set({ pending: patch }),

  confirm: () => {
    const { pending } = get()
    if (!pending) return
    pending.onConfirm()
    set({ pending: null })
  },

  reject: () => {
    const { pending } = get()
    if (!pending) return
    pending.onReject?.()
    set({ pending: null })
  },
}))
