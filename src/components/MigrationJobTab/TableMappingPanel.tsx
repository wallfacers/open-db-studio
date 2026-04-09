import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Copy, Trash2, Columns3, Sparkles } from 'lucide-react'
import { ColumnMappingPanel } from './ColumnMappingPanel'
import { ComboboxSelect } from '../common/ComboboxSelect'

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
  const [expandedIdxs, setExpandedIdxs] = useState<Set<number>>(() => new Set(mappings.map((_, i) => i)))

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
  }

  const removeRow = (idx: number) => {
    onUpdate(mappings.filter((_, i) => i !== idx))
    setExpandedIdxs(prev => {
      const next = new Set(prev)
      next.delete(idx)
      return next
    })
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
      <div className="grid grid-cols-[minmax(120px,1fr)_minmax(120px,1fr)_minmax(160px,2fr)_auto] gap-2 mb-1 text-[10px] text-foreground-subtle px-2">
        <span>{t('migration.sourceTable')}</span>
        <span>{t('migration.targetTable')}</span>
        <span>{t('migration.filterCondition')}</span>
        <span className="w-[84px]" />
      </div>

      {/* Rows */}
      {mappings.map((m, idx) => {
        const tKey = `${m.target.connectionId}:${m.target.database}:${m.target.table}`
        const isMultiTarget = !!(m.target.table && (targetCounts.get(tKey) || 0) > 1)
        const isMultiSource = !!(m.sourceTable && (sourceCounts.get(m.sourceTable) || 0) > 1)
        const isExpanded = expandedIdxs.has(idx)
        const toggleExpand = () => {
          setExpandedIdxs(prev => {
            const next = new Set(prev)
            if (next.has(idx)) next.delete(idx); else next.add(idx)
            return next
          })
        }
        return (
          <div key={idx}>
            <div className="grid grid-cols-[minmax(120px,1fr)_minmax(120px,1fr)_minmax(160px,2fr)_auto] gap-2 mb-1 hover:bg-background-hover rounded px-2 py-0.5 transition-colors items-center">
              <input value={m.sourceTable} readOnly className={inputCls + " w-full opacity-70 cursor-default"} />
              <ComboboxSelect
                value={m.target.table}
                options={targetTables.map(t => ({ value: t.name, label: t.name }))}
                onChange={val => updateTarget(idx, { table: val })}
                placeholder={t('migration.targetTable')}
                wrapperClassName="w-full"
              />
              <input
                value={m.filterCondition || ''}
                onChange={e => updateMapping(idx, { filterCondition: e.target.value })}
                placeholder="WHERE id > 100 AND status = 'active'"
                className={inputCls + " w-full font-mono"}
              />
              <div className="flex items-center gap-0.5">
                <button onClick={toggleExpand}
                  className={`p-1 text-foreground-muted hover:text-foreground transition-colors rounded ${isExpanded ? 'text-accent' : ''}`}
                  title={t('migration.columnMapping')}>
                  <Columns3 size={14} />
                </button>
                <button onClick={() => duplicateRow(idx)}
                  className="p-1 text-foreground-muted hover:text-foreground transition-colors rounded"
                  title={t('migration.duplicateRow')}>
                  <Copy size={14} />
                </button>
                <button onClick={() => removeRow(idx)}
                  className="p-1 text-foreground-muted hover:text-error transition-colors rounded"
                  title={t('migration.delete')}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            {/* Inline expand: column mapping */}
            {isExpanded && (
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
