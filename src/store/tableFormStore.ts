import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'

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

export type EditableColumn = TableFormColumn

export interface TableFormIndex {
  id: string
  name: string
  type: 'INDEX' | 'UNIQUE' | 'FULLTEXT'
  columns: string           // JSON string: [{ name: string, order: 'ASC' | 'DESC' }]
  _isNew?: boolean
  _isDeleted?: boolean
  _originalName?: string    // for ALTER tracking
}

export interface TableFormForeignKey {
  id: string
  constraintName: string        // e.g. fk_orders_user_id
  column: string                // 当前表的列名
  referencedTable: string       // 引用目标表名
  referencedColumn: string      // 引用目标列名
  onDelete: string              // NO ACTION | CASCADE | SET NULL | RESTRICT | SET DEFAULT
  onUpdate: string
  _isNew?: boolean
  _isDeleted?: boolean
  _originalName?: string        // 用于 ALTER 时追踪约束名变化
}

export interface TableFormState {
  tableName: string
  engine: string
  charset: string
  comment: string
  columns: TableFormColumn[]
  originalColumns?: TableFormColumn[]
  indexes: TableFormIndex[]
  originalIndexes?: TableFormIndex[]
  foreignKeys: TableFormForeignKey[]
  originalForeignKeys?: TableFormForeignKey[]
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

/** 判断 tabId 是否为新建表（未保存到数据库） */
function isNewTableTab(tabId: string): boolean {
  return tabId.includes('_new_')
}

/** 防抖写入新建表表单状态到文件 */
const _saveFormTimers: Record<string, ReturnType<typeof setTimeout>> = {}
function persistFormState(tabId: string, state: TableFormState): void {
  if (!isNewTableTab(tabId)) return
  if (_saveFormTimers[tabId]) clearTimeout(_saveFormTimers[tabId])
  _saveFormTimers[tabId] = setTimeout(() => {
    invoke('write_tab_file', { tabId, content: JSON.stringify(state) }).catch(() => {})
  }, 500)
}

/** 从文件加载新建表表单状态 */
export async function loadPersistedFormState(tabId: string): Promise<TableFormState | null> {
  if (!isNewTableTab(tabId)) return null
  try {
    const raw = await invoke<string | null>('read_tab_file', { tabId })
    if (!raw) return null
    const parsed = JSON.parse(raw) as TableFormState
    // 基本校验：必须有 columns 数组
    if (!Array.isArray(parsed.columns)) return null
    if (!Array.isArray(parsed.indexes)) parsed.indexes = []
    if (!Array.isArray(parsed.foreignKeys)) parsed.foreignKeys = []
    return parsed
  } catch {
    return null
  }
}

export const useTableFormStore = create<TableFormStoreState>((set, get) => ({
  forms: {},

  initForm: (tabId, initial) => {
    set(s => ({ forms: { ...s.forms, [tabId]: initial } }))
    persistFormState(tabId, initial)
  },

  patchForm: (tabId, updater) => set(s => {
    const current = s.forms[tabId]
    if (!current) return s
    const updated = updater(current)
    persistFormState(tabId, updated)
    return { forms: { ...s.forms, [tabId]: updated } }
  }),

  setForm: (tabId, state) => {
    set(s => ({ forms: { ...s.forms, [tabId]: state } }))
    persistFormState(tabId, state)
  },

  removeForm: (tabId) => set(s => {
    const { [tabId]: _, ...rest } = s.forms
    return { forms: rest }
  }),

  getForm: (tabId) => get().forms[tabId],
}))
