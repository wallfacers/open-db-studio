import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { Sparkles, Plus, Trash2, TableProperties } from 'lucide-react'
import { DropdownSelect } from '../common/DropdownSelect'
import { INPUT_CLS } from './styles'

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
  mapping: TableMapping
  onUpdate: (patch: Partial<TableMapping>) => void
  onUpdateTarget: (patch: Partial<TargetConfig>) => void
  hasAi: boolean
  aiLoading: boolean
  onAiRecommend: () => void
}

export function ColumnMappingPanel({ mapping, onUpdate, onUpdateTarget, hasAi, aiLoading, onAiRecommend }: Props) {
  const { t } = useTranslation()

  const cms = mapping.columnMappings

  const updateCm = (idx: number, patch: Partial<ColumnMapping>) => {
    const next = [...cms]
    next[idx] = { ...next[idx], ...patch }
    onUpdate({ columnMappings: next })
  }

  const removeCm = (idx: number) => onUpdate({ columnMappings: cms.filter((_, i) => i !== idx) })
  const addCm = () => onUpdate({ columnMappings: [...cms, { sourceExpr: '', targetCol: '', targetType: 'TEXT' }] })

  const deriveFromSource = async () => {
    try {
      const detail = await invoke<{ columns: Array<{ name: string; dataType: string }> }>(
        'get_table_detail', {
          connectionId: mapping.target.connectionId,
          database: mapping.target.database || undefined,
          table: mapping.sourceTable,
        })
      const derived = detail.columns.map(c => ({
        sourceExpr: c.name, targetCol: c.name, targetType: c.dataType,
      }))
      onUpdate({ columnMappings: derived })
    } catch (e) {
      console.error('Derive from source failed:', e)
    }
  }

  return (
    <div className="bg-background-elevated border border-border-subtle rounded p-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-medium text-foreground-default">
          {mapping.sourceTable} → {mapping.target.table || '?'} {t('migration.columnMapping')}
        </span>
        <div className="flex items-center gap-2">
          {hasAi && (
            <button onClick={onAiRecommend} disabled={aiLoading}
              className="flex items-center gap-1 px-2 py-0.5 text-[10px] bg-accent text-foreground rounded hover:bg-accent-hover transition-colors disabled:opacity-50">
              <Sparkles size={10} />{aiLoading ? t('migration.generating') : t('migration.aiGenMapping')}
            </button>
          )}
          <button onClick={deriveFromSource}
            className="flex items-center gap-1 px-2 py-0.5 text-[10px] border border-border-strong text-foreground-muted rounded hover:bg-background-hover transition-colors">
            <TableProperties size={10} />{t('migration.deriveFromSource')}
          </button>
        </div>
      </div>

      {/* Column mapping rows header */}
      <div className="grid grid-cols-[1fr_1fr_100px_24px] gap-1 mb-1 text-[10px] text-foreground-subtle px-1">
        <span>{t('migration.sourceFieldExpr')}</span>
        <span>{t('migration.targetField')}</span>
        <span>{t('migration.targetType')}</span>
        <span />
      </div>

      {cms.map((cm, idx) => (
        <div key={idx} className="grid grid-cols-[1fr_1fr_100px_24px] gap-1 mb-1 hover:bg-background-hover rounded px-1 py-0.5 transition-colors">
          <input value={cm.sourceExpr} onChange={e => updateCm(idx, { sourceExpr: e.target.value })} className={INPUT_CLS + " w-full"} placeholder={t('migration.sourceFieldExpr')} />
          <input value={cm.targetCol} onChange={e => updateCm(idx, { targetCol: e.target.value })} className={INPUT_CLS + " w-full"} placeholder={t('migration.targetField')} />
          <input value={cm.targetType} onChange={e => updateCm(idx, { targetType: e.target.value })} className={INPUT_CLS + " w-full"} placeholder={t('migration.targetType')} />
          <button onClick={() => removeCm(idx)} className="p-0.5 text-foreground-muted hover:text-error transition-colors">
            <Trash2 size={11} />
          </button>
        </div>
      ))}

      <button onClick={addCm} className="mt-1 text-[11px] text-foreground-muted hover:text-foreground flex items-center gap-1 transition-colors">
        <Plus size={12} />{t('migration.addField')}
      </button>

      {/* Target options */}
      <div className="mt-2 pt-2 border-t border-border-subtle flex items-center gap-4 text-[11px]">
        <label className="flex items-center gap-1.5 text-foreground-muted cursor-pointer">
          <input type="checkbox" checked={mapping.target.createIfNotExists}
            onChange={e => onUpdateTarget({ createIfNotExists: e.target.checked })}
            className="accent-accent" />
          {t('migration.autoCreateTable')}
        </label>
        <div className="flex items-center gap-1.5">
          <span className="text-foreground-subtle">{t('migration.conflictStrategy')}:</span>
          <DropdownSelect
            value={mapping.target.conflictStrategy}
            onChange={val => onUpdateTarget({ conflictStrategy: val })}
            options={[
              { value: 'INSERT', label: t('migration.conflictInsert') },
              { value: 'UPSERT', label: t('migration.conflictUpsert') },
              { value: 'REPLACE', label: t('migration.conflictReplace') },
              { value: 'SKIP', label: t('migration.conflictSkip') },
            ]}
            className="w-24"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-foreground-subtle">{t('migration.upsertKeys')}:</span>
          <input
            value={mapping.target.upsertKeys.join(', ')}
            onChange={e => onUpdateTarget({ upsertKeys: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
            disabled={mapping.target.conflictStrategy !== 'UPSERT'}
            className={INPUT_CLS + ' w-32' + (mapping.target.conflictStrategy !== 'UPSERT' ? ' opacity-50 cursor-not-allowed' : '')}
            placeholder="id"
          />
        </div>
      </div>
    </div>
  )
}
