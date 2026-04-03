/**
 * Adapter functions to bridge TableFormIndex/TableFormColumn types
 * with ErIndex/ErColumn types used by the shared IndexEditor component.
 */
import type { ErIndex, ErColumn, IndexMeta } from '@/types'
import type { TableFormColumn, TableFormIndex } from '@/store/tableFormStore'
import { makeId } from '@/utils/makeId'
import { stringifyIndexColumns } from '@/utils/indexColumns'

// ── ID mapping (string ↔ number) ─────────────────────────────────────────

export interface IdMap {
  toNum(strId: string): number
  toStr(numId: number): string
}

export function makeIdMap(): IdMap {
  const s2n = new Map<string, number>()
  const n2s = new Map<number, string>()
  let counter = 1

  return {
    toNum(strId: string): number {
      let n = s2n.get(strId)
      if (n == null) {
        n = counter++
        s2n.set(strId, n)
        n2s.set(n, strId)
      }
      return n
    },
    toStr(numId: number): string {
      return n2s.get(numId) ?? ''
    },
  }
}

// ── TableFormColumn → ErColumn ────────────────────────────────────────────

export function tableFormColumnsToErColumns(
  cols: TableFormColumn[],
  idMap: IdMap,
): ErColumn[] {
  return cols.map(c => ({
    id: idMap.toNum(c.id),
    table_id: 0,
    name: c.name,
    data_type: c.dataType,
    nullable: c.isNullable ?? true,
    default_value: c.defaultValue ?? null,
    is_primary_key: c.isPrimaryKey ?? false,
    is_auto_increment: false,
    comment: c.comment ?? null,
    length: null,
    scale: null,
    is_unique: false,
    unsigned: false,
    charset: null,
    collation: null,
    on_update: null,
    enum_values: null,
    sort_order: 0,
    created_at: '',
    updated_at: '',
  }))
}

// ── TableFormIndex → ErIndex ──────────────────────────────────────────────

export function tableFormIndexesToErIndexes(
  indexes: TableFormIndex[],
  idMap: IdMap,
): ErIndex[] {
  return indexes.map(idx => ({
    id: idMap.toNum(idx.id),
    table_id: 0,
    name: idx.name,
    type: idx.type,
    columns: idx.columns,
    created_at: '',
  }))
}

// ── IndexMeta (backend) → TableFormIndex ──────────────────────────────────

export function indexMetaToTableFormIndex(meta: IndexMeta): TableFormIndex {
  return {
    id: makeId(),
    name: meta.index_name,
    type: meta.is_unique ? 'UNIQUE' : 'INDEX',
    columns: stringifyIndexColumns(meta.columns.map(c => ({ name: c, order: 'ASC' }))),
    _originalName: meta.index_name,
  }
}
