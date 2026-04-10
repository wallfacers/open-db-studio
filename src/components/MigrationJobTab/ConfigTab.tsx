import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { ConnectionDbSelector } from '../common/ConnectionDbSelector'
import { TableSelector, TableInfo } from '../ImportExport/TableSelector'
import { TableMappingPanel } from './TableMappingPanel'
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
interface PipelineConfig {
  readBatchSize: number; writeBatchSize: number; parallelism: number
  channelCapacity: number; speedLimitRps: number | null; errorLimit: number
  shardCount: number | null
}
interface JobConfig {
  defaultTargetConnId: number
  defaultTargetDb: string
  source: {
    connectionId: number; database: string
    queryMode: 'auto' | 'custom'
    tables: string[]; customQuery?: string
  }
  tableMappings: TableMapping[]
  pipeline: PipelineConfig
}

export interface ConfigTabHandle {
  save: () => Promise<void>
}

interface Props {
  jobId: number
  configJson: string
  onSave: (configJson: string, silent?: boolean) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}

function defaultConfig(): JobConfig {
  return {
    defaultTargetConnId: 0,
    defaultTargetDb: '',
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

export const ConfigTab = forwardRef<ConfigTabHandle, Props>(function ConfigTab(
  { jobId: _jobId, configJson, onSave, onDirtyChange },
  ref
) {
  const { t } = useTranslation()
  const [sourceTables, setSourceTables] = useState<TableInfo[]>([])
  const [targetTables, setTargetTables] = useState<Array<{ name: string }>>([])
  const [tablesLoading, setTablesLoading] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [aiLoadingMap, setAiLoadingMap] = useState<Record<number, boolean>>({})
  const [hasAi, setHasAi] = useState(false)

  const [config, setConfig] = useState<JobConfig>(() => {
    try {
      const parsed = JSON.parse(configJson)
      const def = defaultConfig()
      return {
        ...def,
        ...parsed,
        defaultTargetConnId: parsed.defaultTargetConnId ?? parsed.tableMappings?.[0]?.target?.connectionId ?? 0,
        defaultTargetDb: parsed.defaultTargetDb ?? parsed.tableMappings?.[0]?.target?.database ?? '',
        source: { ...def.source, ...(parsed.source || {}) },
        pipeline: { ...def.pipeline, ...(parsed.pipeline || {}) },
        tableMappings: parsed.tableMappings || [],
      }
    } catch {
      return defaultConfig()
    }
  })

  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])

  useImperativeHandle(ref, () => ({
    save: async () => {
      if (dirtyRef.current) {
        await onSave(JSON.stringify(config, null, 2))
        setDirty(false)
      }
    },
  }), [config, onSave])

  useEffect(() => {
    if (!dirtyRef.current && configJson) {
      try {
        const parsed = JSON.parse(configJson)
        const def = defaultConfig()
        setConfig({
          ...def,
          ...parsed,
          defaultTargetConnId: parsed.defaultTargetConnId ?? parsed.tableMappings?.[0]?.target?.connectionId ?? 0,
          defaultTargetDb: parsed.defaultTargetDb ?? parsed.tableMappings?.[0]?.target?.database ?? '',
          source: { ...def.source, ...(parsed.source || {}) },
          pipeline: { ...def.pipeline, ...(parsed.pipeline || {}) },
          tableMappings: parsed.tableMappings || [],
        })
      } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configJson])

  useEffect(() => {
    invoke<{ id: number } | null>('get_default_llm_config')
      .then(r => setHasAi(r !== null))
      .catch(() => setHasAi(false))
  }, [])

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
    if (!config.defaultTargetConnId || !config.defaultTargetDb) {
      setTargetTables([])
      return
    }
    invoke<Array<{ name: string }>>('get_tables', { connectionId: config.defaultTargetConnId, database: config.defaultTargetDb })
      .then(setTargetTables)
      .catch(() => setTargetTables([]))
  }, [config.defaultTargetConnId, config.defaultTargetDb])

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
          connectionId: config.defaultTargetConnId,
          database: config.defaultTargetDb,
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

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto h-full">
      {/* Source + Target defaults */}
      <div className="grid grid-cols-2 gap-4">
        {/* Source */}
        <div className="bg-background-panel border border-border-subtle rounded p-3 flex flex-col gap-2">
          <div className="text-[11px] text-foreground-muted uppercase tracking-wide">{t('migration.sourceEnd')}</div>
          <ConnectionDbSelector
            connectionId={config.source.connectionId}
            database={config.source.database}
            onConnectionChange={val => update({
              source: { ...config.source, connectionId: val, database: '', tables: [] },
              tableMappings: [],
            })}
            onDatabaseChange={val => update({
              source: { ...config.source, database: val, tables: [] },
              tableMappings: [],
            })}
            connectionPlaceholder={t('migration.sourceConn')}
            databasePlaceholder={t('migration.sourceDatabase')}
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
              className={INPUT_CLS + " w-full resize-none font-mono text-[11px]"}
            />
          )}
        </div>

        {/* Target defaults */}
        <div className="bg-background-panel border border-border-subtle rounded p-3 flex flex-col gap-2">
          <div className="text-[11px] text-foreground-muted uppercase tracking-wide">
            {t('migration.targetEnd')} ({t('migration.defaults')})
          </div>
          <ConnectionDbSelector
            connectionId={config.defaultTargetConnId}
            database={config.defaultTargetDb}
            onConnectionChange={val => update({ defaultTargetConnId: val, defaultTargetDb: '' })}
            onDatabaseChange={val => update({ defaultTargetDb: val })}
            connectionPlaceholder={t('migration.targetConn')}
            databasePlaceholder={t('migration.targetDatabase')}
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
                  className={INPUT_CLS + " w-full"}
                />
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Table Mapping */}
      <TableMappingPanel
        mappings={config.tableMappings}
        defaultTarget={{ connectionId: config.defaultTargetConnId, database: config.defaultTargetDb }}
        targetTables={targetTables}
        onUpdate={tableMappings => update({ tableMappings })}
        hasAi={hasAi}
        onAiRecommend={handleAiRecommend}
        aiLoadingMap={aiLoadingMap}
      />

    </div>
  )
}) // forwardRef 闭合
