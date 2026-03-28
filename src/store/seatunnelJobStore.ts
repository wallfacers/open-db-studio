import { create } from 'zustand'

export interface SeaTunnelJobFormState {
  jobId?: number
  jobName: string
  configJson: string
  connectionId?: number
  categoryId?: number
}

interface SeaTunnelJobFormStoreState {
  forms: Record<string, SeaTunnelJobFormState>
  initForm: (tabId: string, initial: SeaTunnelJobFormState) => void
  setForm: (tabId: string, state: SeaTunnelJobFormState) => void
  removeForm: (tabId: string) => void
  getForm: (tabId: string) => SeaTunnelJobFormState | undefined
}

export const useSeaTunnelJobFormStore = create<SeaTunnelJobFormStoreState>((set, get) => ({
  forms: {},

  initForm: (tabId, initial) => set(s => ({
    forms: { ...s.forms, [tabId]: initial },
  })),

  setForm: (tabId, state) => set(s => ({
    forms: { ...s.forms, [tabId]: state },
  })),

  removeForm: (tabId) => set(s => {
    const { [tabId]: _, ...rest } = s.forms
    return { forms: rest }
  }),

  getForm: (tabId) => get().forms[tabId],
}))
