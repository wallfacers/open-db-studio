import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { Sparkles, Plus, Trash2, Play, ShieldCheck, Save } from 'lucide-react'
import { DropdownSelect } from '../common/DropdownSelect'
import { TableSelector } from '../ImportExport/TableSelector'

interface ColumnMapping { sourceExpr: string; targetCol: string; targetType: string }
interface PipelineConfig {
  readBatchSize: number; writeBatchSize: number; parallelism: number
  speedLimitRps: number | null; errorLimit: number
}
interface JobConfig {
  source: { connectionId: number; queryMode: 'auto' | 'custom'; query: string; tables: string[] }
  columnMapping: ColumnMapping[]
  target: { connectionId: number; table: string; conflictStrategy: string; createTableIfNotExists: boolean; upsertKeys: string[] }
  pipeline: PipelineConfig
}

interface Props {
  jobId: number
  configJson: string
  onSave: (configJson: string) => void
  onRun: () => void
  onPrecheck: () => void
}

function defaultConfig(): JobConfig {
  return {
    source: { connectionId: 0, queryMode: 'auto', query: '', tables: [] },
    columnMapping: [],
    target: { connectionId: 0, table: '', conflictStrategy: 'INSERT', createTableIfNotExists: false, upsertKeys: [] },
    pipeline: { readBatchSize: 10000, writeBatchSize: 1000, parallelism: 1, speedLimitRps: null, errorLimit: 0 },
  }
}

export function ConfigTab({ jobId: _jobId, configJson, onSave, onRun, onPrecheck }: Props) {
  const { t } = useTranslation()
  const [connections, setConnections] = useState<Array<{ id: number; name: string }>>([])
  const [sourceTables, setSourceTables] = useState<Array<{ name: string }>>([])
  const [tablesLoading, setTablesLoading] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [dirty, setDirty] = useState(false)

  const [config, setConfig] = useState<JobConfig>(() => {
    const def = defaultConfig()
    try { 
      const parsed = JSON.parse(configJson)
      if (parsed && typeof parsed === 'object') {
        return {
          ...def,
          ...parsed,
          source: { ...def.source, ...(parsed.source || {}) },
          target: { ...def.target, ...(parsed.target || {}) },
          pipeline: { ...def.pipeline, ...(parsed.pipeline || {}) },
          columnMapping: parsed.columnMapping || [],
        }
      }
      return def
    } catch { 
      return def 
    }
  })

  useEffect(() => {
    if (!dirty && configJson) {
      try {
        const parsed = JSON.parse(configJson)
        if (parsed && typeof parsed === 'object') {
          const def = defaultConfig()
          setConfig({
            ...def,
            ...parsed,
            source: { ...def.source, ...(parsed.source || {}) },
            target: { ...def.target, ...(parsed.target || {}) },
            pipeline: { ...def.pipeline, ...(parsed.pipeline || {}) },
            columnMapping: parsed.columnMapping || [],
          })
        }
      } catch {}
    }
  }, [configJson, dirty])

  useEffect(() => {
    invoke<Array<{ id: number; name: string }>>('list_connections').then(setConnections).catch(() => {})
  }, [])

  useEffect(() => {
    if (!config.source.connectionId) {
      setSourceTables([])
      return
    }
    setTablesLoading(true)
    invoke<Array<{ name: string }>>('get_tables', { connectionId: config.source.connectionId, database: null })
      .then(setSourceTables)
      .catch(() => setSourceTables([]))
      .finally(() => setTablesLoading(false))
  }, [config.source.connectionId])

  const update = (patch: Partial<JobConfig>) => {
    setConfig(prev => ({ ...prev, ...patch }))
    setDirty(true)
  }

  const addMapping = () => update({ columnMapping: [...config.columnMapping, { sourceExpr: '', targetCol: '', targetType: 'TEXT' }] })
  const removeMapping = (i: number) => update({ columnMapping: config.columnMapping.filter((_, idx) => idx !== i) })
  const updateMapping = (i: number, patch: Partial<ColumnMapping>) => {
    const m = [...config.columnMapping]
    m[i] = { ...m[i], ...patch }
    update({ columnMapping: m })
  }

  const handleAiGenMapping = async () => {
    setAiLoading(true)
    try {
      alert(t('migration.aiMappingHint'))
    } finally {
      setAiLoading(false)
    }
  }

  const handleSave = () => {
    onSave(JSON.stringify(config, null, 2))
    setDirty(false)
  }

  const inputCls = "bg-background-elevated border border-border-strong rounded px-2 py-1 text-[12px] text-foreground-default outline-none focus:border-border-focus transition-colors"

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto h-full">
      {/* Source + Target row */}
      <div className="grid grid-cols-2 gap-4">
        {/* Source */}
        <div className="bg-background-panel border border-border-subtle rounded p-3 flex flex-col gap-2">
          <div className="text-[11px] text-foreground-muted uppercase tracking-wide">{t('migration.sourceEnd')}</div>
          <DropdownSelect
            value={config.source.connectionId ? String(config.source.connectionId) : ''}
            onChange={val => update({ source: { ...config.source, connectionId: val ? Number(val) : 0 } })}
            options={connections.map(c => ({ value: String(c.id), label: c.name }))}
            placeholder={t('migration.sourceConn')}
            className="w-full"
          />

          <div className="flex gap-2 text-[12px]">
            <label className="flex items-center gap-1 cursor-pointer text-foreground-muted">
              <input type="radio" checked={config.source.queryMode === 'auto'} onChange={() => update({ source: { ...config.source, queryMode: 'auto' } })} className="accent-accent" />
              {t('migration.tableMode')}
            </label>
            <label className="flex items-center gap-1 cursor-pointer text-foreground-muted">
              <input type="radio" checked={config.source.queryMode === 'custom'} onChange={() => update({ source: { ...config.source, queryMode: 'custom' } })} className="accent-accent" />
              {t('migration.sqlMode')}
            </label>
          </div>

          {config.source.queryMode === 'auto' && (
            <div className="h-[180px] overflow-hidden flex flex-col">
              {tablesLoading ? (
                <div className="text-[11px] text-foreground-muted py-2">{t('migration.loadingTables')}</div>
              ) : (
                <TableSelector
                  tables={sourceTables}
                  selected={config.source.tables}
                  onChange={tables => update({ source: { ...config.source, tables } })}
                />
              )}
            </div>
          )}

          {config.source.queryMode === 'custom' && (
            <textarea
              value={config.source.query}
              onChange={e => update({ source: { ...config.source, query: e.target.value } })}
              placeholder="SELECT ..."
              rows={6}
              className={inputCls + " w-full resize-none font-mono text-[11px]"}
            />
          )}
        </div>

        {/* Target */}
        <div className="bg-background-panel border border-border-subtle rounded p-3 flex flex-col gap-2">
          <div className="text-[11px] text-foreground-muted uppercase tracking-wide">{t('migration.targetEnd')}</div>
          <DropdownSelect
            value={config.target.connectionId ? String(config.target.connectionId) : ''}
            onChange={val => update({ target: { ...config.target, connectionId: val ? Number(val) : 0 } })}
            options={connections.map(c => ({ value: String(c.id), label: c.name }))}
            placeholder={t('migration.targetConn')}
            className="w-full"
          />

          <input
            value={config.target.table}
            onChange={e => update({ target: { ...config.target, table: e.target.value } })}
            placeholder="target_table_name"
            className={inputCls + " w-full"}
          />

          <DropdownSelect
            value={config.target.conflictStrategy}
            onChange={val => update({ target: { ...config.target, conflictStrategy: val } })}
            options={['INSERT', 'UPSERT', 'REPLACE', 'SKIP'].map(s => ({ value: s, label: s }))}
            className="w-full"
          />

          <label className="flex items-center gap-2 text-[12px] text-foreground-muted cursor-pointer">
            <input
              type="checkbox"
              checked={config.target.createTableIfNotExists}
              onChange={e => update({ target: { ...config.target, createTableIfNotExists: e.target.checked } })}
              className="accent-accent"
            />
            {t('migration.autoCreateTable')}
          </label>

          {/* Pipeline params */}
          <div className="border-t border-border-subtle pt-2 mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
            {([
              ['readBatchSize', t('migration.readBatch')],
              ['writeBatchSize', t('migration.writeBatch')],
              ['parallelism', t('migration.parallelism')],
              ['errorLimit', t('migration.errorLimit')],
            ] as [keyof PipelineConfig, string][]).map(([key, label]) => (
              <label key={key} className="flex flex-col gap-0.5">
                <span className="text-[10px] text-foreground-subtle">{label}</span>
                <input
                  type="number" min={0}
                  value={config.pipeline[key] as number ?? 0}
                  onChange={e => update({ pipeline: { ...config.pipeline, [key]: Number(e.target.value) } })}
                  className={inputCls + " w-full"}
                />
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Field Mapping */}
      <div className="bg-background-panel border border-border-subtle rounded p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[12px] font-medium text-foreground-default">{t('migration.fieldMapping')}</span>
          <button
            onClick={handleAiGenMapping}
            disabled={aiLoading}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] bg-accent text-foreground rounded hover:bg-accent-hover transition-colors duration-150 disabled:opacity-50"
          >
            <Sparkles size={12} />
            {aiLoading ? t('migration.generating') : t('migration.aiGenMapping')}
          </button>
        </div>

        <div className="grid grid-cols-[1fr_1fr_120px_28px] gap-1 mb-1 text-[10px] text-foreground-subtle px-1">
          <span>{t('migration.sourceFieldExpr')}</span><span>{t('migration.targetField')}</span><span>{t('migration.targetType')}</span><span />
        </div>

        {config.columnMapping.map((m, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_120px_28px] gap-1 mb-1 hover:bg-background-hover rounded px-1 py-0.5 transition-colors duration-150">
            <input value={m.sourceExpr} onChange={e => updateMapping(i, { sourceExpr: e.target.value })} className={inputCls + " w-full"} placeholder="col or expr" />
            <input value={m.targetCol} onChange={e => updateMapping(i, { targetCol: e.target.value })} className={inputCls + " w-full"} placeholder="target_col" />
            <input value={m.targetType} onChange={e => updateMapping(i, { targetType: e.target.value })} className={inputCls + " w-full"} placeholder="TEXT" />
            <button onClick={() => removeMapping(i)} className="p-1 text-foreground-muted hover:text-error transition-colors duration-150">
              <Trash2 size={12} />
            </button>
          </div>
        ))}

        <button onClick={addMapping} className="mt-1 text-[11px] text-foreground-muted hover:text-foreground flex items-center gap-1 transition-colors duration-150">
          <Plus size={12} />{t('migration.addField')}
        </button>
      </div>

      {/* Action Bar */}
      <div className="flex items-center justify-end gap-2 border-t border-border-subtle pt-3 mt-auto">
        <button onClick={onPrecheck} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] border border-border-strong text-foreground-muted rounded hover:bg-background-hover transition-colors duration-150">
          <ShieldCheck size={13} />{t('migration.precheck')}
        </button>
        <button onClick={handleSave} disabled={!dirty} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] border border-border-strong text-foreground-muted rounded hover:bg-background-hover transition-colors duration-150 disabled:opacity-40">
          <Save size={13} />{t('migration.save')}
        </button>
        <button onClick={onRun} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] bg-accent text-foreground rounded hover:bg-accent-hover transition-colors duration-200">
          <Play size={13} />{t('migration.run')}
        </button>
      </div>
    </div>
  )
}
