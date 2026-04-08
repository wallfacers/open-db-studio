import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, ChevronDown, Copy, Trash2, Columns3, Sparkles } from 'lucide-react'
import { ColumnMappingPanel } from './ColumnMappingPanel'

interface ColumnMapping { sourceExpr: string; targetCol: string; targetType: string }
interface TargetConfig {
  connectionId: number; database: string; table: string
  conflictStrategy: string; createIfNotExists: boolean; upsertKeys: string[]
}
interface TableMapping {
  sourceTable: string; target: TargetConfig
  filterCondition?: string; columnMappings: ColumnMapping[]
}

interface Props {
  mappings: TableMapping[]
  defaultTarget: { connectionId: number; database: string }
  targetTables: Array<{ name: string }>
  onUpdate: (mappings: TableMapping[]) => void
  hasAi: boolean
  onAiRecommend: (mappingIdx: number) => void
  aiLoadingMap: Record<number, boolean>
}

export function TableMappingPanel({ mappings, defaultTarget, targetTables, onUpdate, hasAi, onAiRecommend, aiLoadingMap }: Props) {
  const { t } = useTranslation()
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const [openMenu, setOpenMenu] = useState<number | null>(null)

  const inputCls = "bg-background-elevated border border-border-strong rounded px-2 py-1 text-[12px] text-foreground-default outline-none focus:border-border-focus transition-colors"

  const updateMapping = (idx: number, patch: Partial<TableMapping>) => {
    const next = [...mappings]
    next[idx] = { ...next[idx], ...patch }
    onUpdate(next)
  }

  const updateTarget = (idx: number, patch: Partial<TargetConfig>) => {
    const next = [...mappings]
    next[idx] = { ...next[idx], target: { ...next[idx].target, ...patch } }
    onUpdate(next)
  }

  const duplicateRow = (idx: number) => {
    const next = [...mappings]
    next.splice(idx + 1, 0, { ...JSON.parse(JSON.stringify(mappings[idx])), filterCondition: '' })
    onUpdate(next)
    setOpenMenu(null)
  }

  const removeRow = (idx: number) => {
    onUpdate(mappings.filter((_, i) => i !== idx))
    if (expandedIdx === idx) setExpandedIdx(null)
    setOpenMenu(null)
  }

  const addRow = () => {
    onUpdate([...mappings, {
      sourceTable: '',
      target: { connectionId: defaultTarget.connectionId, database: defaultTarget.database, table: '', conflictStrategy: 'INSERT', createIfNotExists: false, upsertKeys: [] },
      columnMappings: [],
    }])
  }

  // Detect multi-source → same target (N:1)
  const targetCounts = new Map<string, number>()
  mappings.forEach(m => {
    const key = `${m.target.connectionId}:${m.target.database}:${m.target.table}`
    if (m.target.table) targetCounts.set(key, (targetCounts.get(key) || 0) + 1)
  })

  // Detect same source appearing multiple times (1:N)
  const sourceCounts = new Map<string, number>()
  mappings.forEach(m => {
    if (m.sourceTable) sourceCounts.set(m.sourceTable, (sourceCounts.get(m.sourceTable) || 0) + 1)
  })

  return (
    <div className="bg-background-panel border border-border-subtle rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12px] font-medium text-foreground-default">{t('migration.tableMapping')}</span>
        {hasAi && (
          <button onClick={() => mappings.forEach((_, i) => onAiRecommend(i))}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] bg-accent text-foreground rounded hover:bg-accent-hover transition-colors">
            <Sparkles size={12} />{t('migration.aiRecommendAll')}
          </button>
        )}
      </div>

      {/* Header */}
      <div className="grid grid-cols-[1fr_1fr_1fr_36px] gap-1 mb-1 text-[10px] text-foreground-subtle px-1">
        <span>{t('migration.sourceTable')}</span>
        <span>{t('migration.targetTable')}</span>
        <span>{t('migration.filterCondition')}</span>
        <span />
      </div>

      {/* Rows */}
      {mappings.map((m, idx) => {
        const tKey = `${m.target.connectionId}:${m.target.database}:${m.target.table}`
        const isMultiTarget = !!(m.target.table && (targetCounts.get(tKey) || 0) > 1)
        const isMultiSource = !!(m.sourceTable && (sourceCounts.get(m.sourceTable) || 0) > 1)
        return (
          <div key={idx}>
            <div className="grid grid-cols-[1fr_1fr_1fr_36px] gap-1 mb-1 hover:bg-background-hover rounded px-1 py-0.5 transition-colors">
              <input value={m.sourceTable} readOnly className={inputCls + " w-full opacity-70"} />
              <input
                value={m.target.table}
                onChange={e => updateTarget(idx, { table: e.target.value })}
                placeholder="target_table"
                list={`target-tables-${idx}`}
                className={inputCls + " w-full"}
              />
              <datalist id={`target-tables-${idx}`}>
                {targetTables.map(t => <option key={t.name} value={t.name} />)}
              </datalist>
              <input
                value={m.filterCondition || ''}
                onChange={e => updateMapping(idx, { filterCondition: e.target.value })}
                placeholder={isMultiSource ? "WHERE ..." : ""}
                className={inputCls + " w-full"}
              />
              <div className="relative">
                <button onClick={() => setOpenMenu(openMenu === idx ? null : idx)}
                  className="p-1 text-foreground-muted hover:text-foreground transition-colors">
                  <ChevronDown size={14} />
                </button>
                {openMenu === idx && (
                  <div className="absolute right-0 top-full z-50 bg-background-panel border border-border-subtle rounded shadow-lg py-1 min-w-[120px]">
                    <button onClick={() => { setExpandedIdx(expandedIdx === idx ? null : idx); setOpenMenu(null) }}
                      className="w-full px-3 py-1.5 text-[11px] text-left hover:bg-background-hover flex items-center gap-2">
                      <Columns3 size={12} />{t('migration.columnMapping')}
                    </button>
                    <button onClick={() => duplicateRow(idx)}
                      className="w-full px-3 py-1.5 text-[11px] text-left hover:bg-background-hover flex items-center gap-2">
                      <Copy size={12} />{t('migration.duplicateRow')}
                    </button>
                    <button onClick={() => removeRow(idx)}
                      className="w-full px-3 py-1.5 text-[11px] text-left hover:bg-background-hover text-error flex items-center gap-2">
                      <Trash2 size={12} />{t('migration.delete')}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Inline expand: column mapping */}
            {expandedIdx === idx && (
              <div className="ml-2 mr-2 mb-2">
                <ColumnMappingPanel
                  mapping={m}
                  onUpdate={patch => updateMapping(idx, patch)}
                  onUpdateTarget={patch => updateTarget(idx, patch)}
                  hasAi={hasAi}
                  aiLoading={aiLoadingMap[idx] || false}
                  onAiRecommend={() => onAiRecommend(idx)}
                />
              </div>
            )}

            {/* Warnings */}
            {isMultiTarget && idx === mappings.findIndex(mm => `${mm.target.connectionId}:${mm.target.database}:${mm.target.table}` === tKey) && (
              <div className="text-[10px] text-warning px-1 mb-1">
                {t('migration.multiTargetWarning', { table: m.target.table })}
              </div>
            )}
            {isMultiSource && idx === mappings.findIndex(mm => mm.sourceTable === m.sourceTable) && (
              <div className="text-[10px] text-info px-1 mb-1">
                {t('migration.conditionRouteInfo', { table: m.sourceTable, count: sourceCounts.get(m.sourceTable) })}
              </div>
            )}
          </div>
        )
      })}

      <button onClick={addRow} className="mt-1 text-[11px] text-foreground-muted hover:text-foreground flex items-center gap-1 transition-colors">
        <Plus size={12} />{t('migration.addMappingRow')}
      </button>
    </div>
  )
}
