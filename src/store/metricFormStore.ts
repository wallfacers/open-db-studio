import { create } from 'zustand'

export interface MetricFormState {
  metricId?: number
  displayName: string
  name: string
  metricType: 'atomic' | 'composite'
  tableName: string
  columnName: string
  aggregation: string
  filterSql: string
  category: string
  description: string
  connectionId?: number
}

interface MetricFormStoreState {
  forms: Record<string, MetricFormState>
  initForm: (tabId: string, initial: MetricFormState) => void
  setForm: (tabId: string, state: MetricFormState) => void
  removeForm: (tabId: string) => void
  getForm: (tabId: string) => MetricFormState | undefined
}

export const useMetricFormStore = create<MetricFormStoreState>((set, get) => ({
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
