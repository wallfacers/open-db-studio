import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { Play, ShieldCheck, Save } from 'lucide-react'
import { DropdownSelect } from '../common/DropdownSelect'
import { TableSelector, TableInfo } from '../ImportExport/TableSelector'
import { SyncModeSection } from './SyncModeSection'
import { TableMappingPanel } from './TableMappingPanel'
import { X } from 'lucide-react'

interface ColumnMapping { sourceExpr: string; targetCol: string; targetType: string }
interface TargetConfig {
  connectionId: number; database: string; table: string
  conflictStrategy: string; createIfNotExists: boolean; upsertKeys: string[]
}
interface TableMapping {
  sourceTable: string; target: TargetConfig
  filterCondition?: string; columnMappings: ColumnMapping[]
}
interface IncrementalConfig {
  field: string; fieldType: 'timestamp' | 'numeric'; lastValue?: string
}
interface PipelineConfig {
  readBatchSize: number; writeBatchSize: number; parallelism: number
  channelCapacity: number; speedLimitRps: number | null; errorLimit: number
  shardCount: number | null
}
interface JobConfig {
  syncMode: 'full' | 'incremental'
  incrementalConfig?: IncrementalConfig
  source: {
    connectionId: number; database: string
    queryMode: 'auto' | 'custom'
    tables: string[]; customQuery?: string
  }
  tableMappings: TableMapping[]
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
    syncMode: 'full',
    source: { connectionId: 0, database: '', queryMode: 'auto', tables: [] },
    tableMappings: [],
    pipeline: {
      readBatchSize: 10000,
      writeBatchSize: 1000,
      parallelism: 1,
      channelCapacity: 16,
      speedLimitRps: null,
      errorLimit: 0,
      shardCount: null,
    },
  }
}

export function ConfigTab({ jobId: _jobId, configJson, onSave, onRun, onPrecheck }: Props) {
  const { t } = useTranslation()
  const [connections, setConnections] = useState<Array<{ id: number; name: string }>>([])
  const [sourceDatabases, setSourceDatabases] = useState<string[]>([])
  const [targetDatabases, setTargetDatabases] = useState<string[]>([])
  const [sourceTables, setSourceTables] = useState<TableInfo[]>([])
  const [targetTables, setTargetTables] = useState<Array<{ name: string }>>([])
  const [dbsLoading, setDbsLoading] = useState(false)
  const [targetDbsLoading, setTargetDbsLoading] = useState(false)
  const [tablesLoading, setTablesLoading] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [aiLoadingMap, setAiLoadingMap] = useState<Record<number, boolean>>({})
  const [hasAi, setHasAi] = useState(false)
  const savedConfigRef = useRef<JobConfig | null>(null)

  const [defaultTargetConnId, setDefaultTargetConnId] = useState(0)
  const [defaultTargetDb, setDefaultTargetDb] = useState('')

  const [config, setConfig] = useState<JobConfig>(() => {
    try {
      const parsed = JSON.parse(configJson)
      const def = defaultConfig()
      return {
        ...def,
        ...parsed,
        source: { ...def.source, ...(parsed.source || {}) },
        pipeline: { ...def.pipeline, ...(parsed.pipeline || {}) },
        tableMappings: parsed.tableMappings || [],
      }
    } catch {
      return defaultConfig()
    }
  })

  // Initialize saved config ref on mount
  useEffect(() => {
    savedConfigRef.current = JSON.parse(JSON.stringify(config))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!dirty && configJson) {
      try {
        const parsed = JSON.parse(configJson)
        const def = defaultConfig()
        setConfig({
          ...def,
          ...parsed,
          source: { ...def.source, ...(parsed.source || {}) },
          pipeline: { ...def.pipeline, ...(parsed.pipeline || {}) },
          tableMappings: parsed.tableMappings || [],
        })
        if (parsed.tableMappings?.[0]?.target) {
          setDefaultTargetConnId(parsed.tableMappings[0].target.connectionId || 0)
          setDefaultTargetDb(parsed.tableMappings[0].target.database || '')
        }
      } catch {}
    }
  }, [configJson, dirty])

  useEffect(() => {
    invoke<Array<{ id: number; name: string }>>('list_connections').then(setConnections).catch(() => {})
    invoke<{ id: number } | null>('get_default_llm_config')
      .then(r => setHasAi(r !== null))
      .catch(() => setHasAi(false))
  }, [])

  useEffect(() => {
    if (!config.source.connectionId) {
      setSourceDatabases([])
      setSourceTables([])
      return
    }
    setDbsLoading(true)
    invoke<string[]>('list_databases', { connectionId: config.source.connectionId })
      .then(setSourceDatabases)
      .catch(() => setSourceDatabases([]))
      .finally(() => setDbsLoading(false))
  }, [config.source.connectionId])

  useEffect(() => {
    if (!config.source.connectionId || !config.source.database) {
      setSourceTables([])
      return
    }
    setTablesLoading(true)
    invoke<Array<{ name: string; row_count: number | null; size: string | null }>>('list_tables_with_stats', { connectionId: config.source.connectionId, database: config.source.database, schema: null })
      .then(stats => setSourceTables(stats.map(s => ({ name: s.name, rowCount: s.row_count ?? undefined, size: s.size ?? undefined }))))
      .catch(() => setSourceTables([]))
      .finally(() => setTablesLoading(false))
  }, [config.source.connectionId, config.source.database])

  useEffect(() => {
    if (!defaultTargetConnId) {
      setTargetDatabases([])
      setTargetTables([])
      return
    }
    setTargetDbsLoading(true)
    invoke<string[]>('list_databases', { connectionId: defaultTargetConnId })
      .then(setTargetDatabases)
      .catch(() => setTargetDatabases([]))
      .finally(() => setTargetDbsLoading(false))
  }, [defaultTargetConnId])

  useEffect(() => {
    if (!defaultTargetConnId || !defaultTargetDb) {
      setTargetTables([])
      return
    }
    invoke<Array<{ name: string }>>('get_tables', { connectionId: defaultTargetConnId, database: defaultTargetDb })
      .then(setTargetTables)
      .catch(() => setTargetTables([]))
  }, [defaultTargetConnId, defaultTargetDb])

  const update = (patch: Partial<JobConfig>) => {
    setConfig(prev => ({ ...prev, ...patch }))
    setDirty(true)
  }

  const prevTablesRef = useRef<string[]>([])
  useEffect(() => {
    if (config.source.queryMode !== 'auto') return
    const prev = prevTablesRef.current
    const curr = config.source.tables
    prevTablesRef.current = curr

    const existingSources = new Set(config.tableMappings.map(m => m.sourceTable))
    const newTables = curr.filter(t => !existingSources.has(t))

    if (newTables.length === 0 && prev.every(t => curr.includes(t)) && curr.every(t => prev.includes(t) || existingSources.has(t))) return

    let next = config.tableMappings.filter(m => curr.includes(m.sourceTable) || m.sourceTable === 'custom_query')
    for (const t of newTables) {
      next.push({
        sourceTable: t,
        target: {
          connectionId: defaultTargetConnId,
          database: defaultTargetDb,
          table: t,
          conflictStrategy: 'INSERT',
          createIfNotExists: false,
          upsertKeys: [],
        },
        columnMappings: [],
      })
    }
    update({ tableMappings: next })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.source.tables])

  const handleAiRecommend = async (mappingIdx: number) => {
    const m = config.tableMappings[mappingIdx]
    if (!m) return
    setAiLoadingMap(prev => ({ ...prev, [mappingIdx]: true }))
    try {
      const result = await invoke<Array<{ sourceExpr: string; targetCol: string; targetType: string }>>(
        'ai_recommend_column_mappings',
        {
          sourceConnectionId: config.source.connectionId,
          sourceDatabase: config.source.database,
          sourceTable: m.sourceTable,
          targetConnectionId: m.target.connectionId,
          targetDatabase: m.target.database,
          targetTable: m.target.table,
        },
      )
      const next = [...config.tableMappings]
      next[mappingIdx] = { ...next[mappingIdx], columnMappings: result }
      update({ tableMappings: next })
    } catch (e) {
      console.error('AI recommend failed:', e)
    } finally {
      setAiLoadingMap(prev => ({ ...prev, [mappingIdx]: false }))
    }
  }

  const handleSave = () => {
    onSave(JSON.stringify(config, null, 2))
    savedConfigRef.current = JSON.parse(JSON.stringify(config))
    setDirty(false)
  }

  const handleCancel = () => {
    const saved = savedConfigRef.current
    if (saved) {
      setConfig(saved)
      setDefaultTargetConnId(saved.tableMappings?.[0]?.target?.connectionId || 0)
      setDefaultTargetDb(saved.tableMappings?.[0]?.target?.database || '')
    }
    setDirty(false)
  }

  const inputCls = "bg-background-elevated border border-border-strong rounded px-2 py-1 text-[12px] text-foreground-default outline-none focus:border-border-focus transition-colors"

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto h-full">
      {/* Sync Mode */}
      <SyncModeSection
        syncMode={config.syncMode}
        incrementalConfig={config.incrementalConfig}
        onChange={(syncMode, incrementalConfig) => update({ syncMode, incrementalConfig })}
      />

      {/* Source + Target defaults */}
      <div className="grid grid-cols-2 gap-4">
        {/* Source */}
        <div className="bg-background-panel border border-border-subtle rounded p-3 flex flex-col gap-2">
          <div className="text-[11px] text-foreground-muted uppercase tracking-wide">{t('migration.sourceEnd')}</div>
          <DropdownSelect
            value={config.source.connectionId ? String(config.source.connectionId) : ''}
            onChange={val => update({
              source: { ...config.source, connectionId: val ? Number(val) : 0, database: '', tables: [] },
              tableMappings: [],
            })}
            options={connections.map(c => ({ value: String(c.id), label: c.name }))}
            placeholder={t('migration.sourceConn')}
            className="w-full"
          />
          <DropdownSelect
            value={config.source.database}
            onChange={val => update({
              source: { ...config.source, database: val, tables: [] },
              tableMappings: [],
            })}
            options={sourceDatabases.map(db => ({ value: db, label: db }))}
            placeholder={dbsLoading ? t('migration.loadingDatabases') : t('migration.sourceDatabase')}
            className="w-full"
          />
          <div className="flex gap-2 text-[12px]">
            <label className="flex items-center gap-1 cursor-pointer text-foreground-muted">
              <input
                type="radio"
                checked={config.source.queryMode === 'auto'}
                onChange={() => update({ source: { ...config.source, queryMode: 'auto' } })}
                className="accent-accent"
              />
              {t('migration.tableMode')}
            </label>
            <label className="flex items-center gap-1 cursor-pointer text-foreground-muted">
              <input
                type="radio"
                checked={config.source.queryMode === 'custom'}
                onChange={() => update({ source: { ...config.source, queryMode: 'custom' } })}
                className="accent-accent"
              />
              {t('migration.sqlMode')}
            </label>
          </div>
          {config.source.queryMode === 'auto' && (
            <div className="h-[300px] overflow-hidden flex flex-col">
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
              value={config.source.customQuery || ''}
              onChange={e => update({ source: { ...config.source, customQuery: e.target.value } })}
              placeholder="SELECT ..."
              rows={6}
              className={inputCls + " w-full resize-none font-mono text-[11px]"}
            />
          )}
        </div>

        {/* Target defaults */}
        <div className="bg-background-panel border border-border-subtle rounded p-3 flex flex-col gap-2">
          <div className="text-[11px] text-foreground-muted uppercase tracking-wide">
            {t('migration.targetEnd')} ({t('migration.defaults')})
          </div>
          <DropdownSelect
            value={defaultTargetConnId ? String(defaultTargetConnId) : ''}
            onChange={val => {
              setDefaultTargetConnId(val ? Number(val) : 0)
              setDefaultTargetDb('')
              setDirty(true)
            }}
            options={connections.map(c => ({ value: String(c.id), label: c.name }))}
            placeholder={t('migration.targetConn')}
            className="w-full"
          />
          <DropdownSelect
            value={defaultTargetDb}
            onChange={val => {
              setDefaultTargetDb(val)
              setDirty(true)
            }}
            options={targetDatabases.map(db => ({ value: db, label: db }))}
            placeholder={targetDbsLoading ? t('migration.loadingDatabases') : t('migration.targetDatabase')}
            className="w-full"
          />
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
                  type="number"
                  min={0}
                  value={config.pipeline[key] as number ?? 0}
                  onChange={e => update({ pipeline: { ...config.pipeline, [key]: Number(e.target.value) } })}
                  className={inputCls + " w-full"}
                />
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Table Mapping */}
      <TableMappingPanel
        mappings={config.tableMappings}
        defaultTarget={{ connectionId: defaultTargetConnId, database: defaultTargetDb }}
        targetTables={targetTables}
        onUpdate={tableMappings => update({ tableMappings })}
        hasAi={hasAi}
        onAiRecommend={handleAiRecommend}
        aiLoadingMap={aiLoadingMap}
      />

      {/* Action Bar */}
      <div className="flex items-center justify-end gap-2 border-t border-border-subtle pt-3 mt-auto">
        <button
          onClick={onPrecheck}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] border border-border-strong text-foreground-muted rounded hover:bg-background-hover transition-colors"
        >
          <ShieldCheck size={13} />{t('migration.precheck')}
        </button>
        <button
          onClick={handleCancel}
          disabled={!dirty}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] border border-border-strong text-foreground-muted rounded hover:bg-background-hover transition-colors disabled:opacity-40"
        >
          <X size={13} />{t('migration.cancel', { defaultValue: 'Cancel' })}
        </button>
        <button
          onClick={handleSave}
          disabled={!dirty}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] border border-border-strong text-foreground-muted rounded hover:bg-background-hover transition-colors disabled:opacity-40"
        >
          <Save size={13} />{t('migration.save')}
        </button>
        <button
          onClick={onRun}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] bg-accent text-foreground rounded hover:bg-accent-hover transition-colors"
        >
          <Play size={13} />{t('migration.run')}
        </button>
      </div>
    </div>
  )
}
