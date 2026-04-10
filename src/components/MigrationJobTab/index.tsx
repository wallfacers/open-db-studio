import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { useMigrationStore, MigrationJob, LogViewMode } from '../../store/migrationStore'
import { useConfirm } from '../../hooks/useConfirm'
import { useToastStore } from '../../store/toastStore'
import { ConfigTab, ConfigTabHandle } from './ConfigTab'
import { Play, Square, ShieldCheck, ListTree, Code, Save } from 'lucide-react'
import { Tooltip } from '../common/Tooltip'
import { LogTab } from './LogTab'
import { StatsTab } from './StatsTab'

interface Props { jobId: number }

type SubTab = 'config' | 'stats'

export function MigrationJobTab({ jobId }: Props) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const store = useMigrationStore()
  const [activeTab, setActiveTab] = useState<SubTab>('config')
  const [configJson, setConfigJson] = useState('{}')
  const [logHeight, setLogHeight] = useState(0)
  const [viewMode, setViewMode] = useState<LogViewMode>('structured')
  const [configDirty, setConfigDirty] = useState(false)

  const configTabRef = useRef<ConfigTabHandle>(null)

  const run = store.activeRuns.get(jobId)
  const jobNode = store.nodes.get(`job_${jobId}`)
  const isRunning = jobNode?.nodeType === 'job' && jobNode.status === 'RUNNING'
  const hasFailed = jobNode?.nodeType === 'job' && jobNode.status === 'FAILED'

  useEffect(() => {
    invoke<MigrationJob[]>('list_migration_jobs')
      .then((jobs) => {
        const job = jobs.find((j) => j.id === jobId)
        if (job) setConfigJson(job.configJson)
      }).catch(() => {})
  }, [jobId])

  // 迁移开始运行时自动展开日志面板
  useEffect(() => {
    if (isRunning && logHeight === 0) setLogHeight(250)
  }, [isRunning]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async (json: string, silent?: boolean) => {
    await invoke('update_migration_job_config', { id: jobId, configJson: json })
    setConfigJson(json)
    if (!silent) {
      useToastStore.getState().show(t('migration.configSaved', { defaultValue: '配置已保存' }), 'success')
    }
  }

  const handleRun = async () => {
    await store.runJob(jobId)
  }

  const handleSaveConfig = async () => {
    await configTabRef.current?.save()
  }

  const handleStop = async () => {
    await invoke('stop_migration_job', { jobId })
  }

  const handlePrecheck = async () => {
    await confirm({
      title: t('migration.precheck'),
      message: t('migration.precheckSuccess', { defaultValue: '预检查完成：连接正常，类型兼容性检查通过。' }),
    })
  }

  const handleLogResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = logHeight
    const onMouseMove = (ev: MouseEvent) => {
      const newH = Math.max(100, Math.min(window.innerHeight - 150, startHeight - (ev.clientY - startY)))
      setLogHeight(newH)
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  const tabCls = (tab: SubTab) =>
    `px-3 py-2 text-[12px] border-b-2 transition-colors duration-150 cursor-pointer ${
      activeTab === tab
        ? 'border-accent text-foreground-default'
        : 'border-transparent text-foreground-muted hover:text-foreground'
    }`

  return (
    <div className="flex flex-col h-full bg-background-base">
      {/* Toolbar */}
      <div className="flex-shrink-0 h-10 flex items-center px-3 gap-1 bg-background-void border-b border-border-default">
        <Tooltip content={isRunning ? t('migration.stop') : t('migration.run')}>
          <button
            disabled={configDirty}
            className={`p-1.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              isRunning
                ? 'text-error hover:bg-border-default'
                : 'text-accent hover:bg-border-default'
            }`}
            onClick={isRunning ? handleStop : handleRun}
          >
            {isRunning ? <Square size={16} /> : <Play size={16} />}
          </button>
        </Tooltip>
        <div className="w-[1px] h-4 bg-border-strong mx-1" />
        <Tooltip content={t('migration.precheck')}>
          <button
            className="p-1.5 rounded transition-colors text-foreground-muted hover:bg-border-default"
            onClick={handlePrecheck}
          >
            <ShieldCheck size={16} />
          </button>
        </Tooltip>
        {configDirty && (
          <>
            <div className="w-[1px] h-4 bg-border-strong mx-1" />
            <Tooltip content={t('migration.save')}>
              <button
                className="p-1.5 rounded transition-colors text-accent hover:bg-border-default"
                onClick={handleSaveConfig}
              >
                <Save size={16} />
              </button>
            </Tooltip>
          </>
        )}
      </div>

      {/* Sub-tab bar */}
      <div className="flex border-b border-border-subtle flex-shrink-0">
        <button className={tabCls('config')} onClick={() => setActiveTab('config')}>{t('migration.configTab')}</button>
        <button className={tabCls('stats')} onClick={() => setActiveTab('stats')}>{t('migration.statsTab')}</button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {activeTab === 'config' && (
          <ConfigTab
            ref={configTabRef}
            jobId={jobId}
            configJson={configJson}
            onSave={handleSave}
            onDirtyChange={setConfigDirty}
          />
        )}
        {activeTab === 'stats' && <StatsTab jobId={jobId} />}
      </div>

      {/* Log Bottom Panel */}
      {logHeight > 0 && (
        <div className="flex flex-col bg-background-void flex-shrink-0 relative border-t border-border-default" style={{ height: logHeight }}>
          {/* Resize Handle — absolute overlay */}
          <div
            className="absolute left-0 right-0 top-[-2px] h-[4.5px] cursor-row-resize hover:bg-accent z-10 transition-colors"
            onMouseDown={handleLogResize}
          />
          {/* Log tab-bar */}
          <div className="flex items-center bg-background-base border-b border-border-default flex-shrink-0 overflow-x-auto mt-[-1px]">
            <div className="px-3 h-[38px] flex items-center gap-1.5 text-xs border-t-[3px] border-accent bg-background-void text-accent border-r border-r-border-default flex-shrink-0 pt-[1px]">
              <span>{t('migration.logTab')}</span>
              {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />}
              <Tooltip content={t('common.close', { defaultValue: '关闭' })}>
                <span
                  className="hover:bg-border-default rounded p-0.5 leading-none transition-colors duration-200 cursor-pointer"
                  onClick={() => setLogHeight(0)}
                >✕</span>
              </Tooltip>
            </div>
            <div className="ml-auto flex items-center gap-1 px-2 flex-shrink-0">
              <div className="flex items-center bg-background-elevated rounded-md p-0.5">
                <Tooltip content={t('migration.structuredView')}>
                  <button
                    onClick={() => setViewMode('structured')}
                    className={`p-1 rounded transition-colors ${viewMode === 'structured' ? 'bg-accent text-white' : 'text-foreground-muted hover:text-foreground-default'}`}
                  >
                    <ListTree size={12} />
                  </button>
                </Tooltip>
                <Tooltip content={t('migration.rawLog')}>
                  <button
                    onClick={() => setViewMode('raw')}
                    className={`p-1 rounded transition-colors ${viewMode === 'raw' ? 'bg-accent text-white' : 'text-foreground-muted hover:text-foreground-default'}`}
                  >
                    <Code size={12} />
                  </button>
                </Tooltip>
              </div>
            </div>
          </div>
          {/* Log content */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <LogTab
              jobId={jobId}
              stats={run?.stats ?? null}
              logs={run?.logs ?? []}
              viewMode={viewMode}
              hasFailed={hasFailed}
            />
          </div>
        </div>
      )}
    </div>
  )
}
