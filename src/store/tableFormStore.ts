import { create } from 'zustand'

export interface TableFormColumn {
  id: string
  name: string
  dataType: string
  length?: string | null
  isNullable?: boolean
  defaultValue?: string | null
  isPrimaryKey?: boolean
  extra?: string
  comment?: string
  _isNew?: boolean
  _isDeleted?: boolean
  _originalName?: string
}

export interface TableFormState {
  tableName: string
  engine: string
  charset: string
  comment: string
  columns: TableFormColumn[]
  originalColumns?: TableFormColumn[]
  indexes: any[]
  isNewTable?: boolean
}

interface TableFormStoreState {
  forms: Record<string, TableFormState>
  initForm: (tabId: string, initial: TableFormState) => void
  patchForm: (tabId: string, updater: (s: TableFormState) => TableFormState) => void
  setForm: (tabId: string, state: TableFormState) => void
  removeForm: (tabId: string) => void
  getForm: (tabId: string) => TableFormState | undefined
}

export const useTableFormStore = create<TableFormStoreState>((set, get) => ({
  forms: {},

  initForm: (tabId, initial) => set(s => ({
    forms: { ...s.forms, [tabId]: initial },
  })),

  patchForm: (tabId, updater) => set(s => {
    const current = s.forms[tabId]
    if (!current) return s
    return { forms: { ...s.forms, [tabId]: updater(current) } }
  }),

  setForm: (tabId, state) => set(s => ({
    forms: { ...s.forms, [tabId]: state },
  })),

  removeForm: (tabId) => set(s => {
    const { [tabId]: _, ...rest } = s.forms
    return { forms: rest }
  }),

  getForm: (tabId) => get().forms[tabId],
}))
