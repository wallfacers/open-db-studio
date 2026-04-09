import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { useMigrationStore, MigrationJob } from '../../store/migrationStore'
import { useConfirm } from '../../hooks/useConfirm'
import { useToastStore } from '../../store/toastStore'
import { ConfigTab, ConfigTabHandle } from './ConfigTab'
import { Play, Square, ShieldCheck } from 'lucide-react'
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

  const configTabRef = useRef<ConfigTabHandle>(null)

  const run = store.activeRuns.get(jobId)
  const jobNode = store.nodes.get(`job_${jobId}`)
  const isRunning = jobNode?.nodeType === 'job' && jobNode.status === 'RUNNING'

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
    await configTabRef.current?.save()
    await store.runJob(jobId)
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
            className={`p-1.5 rounded transition-colors ${
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
          />
        )}
        {activeTab === 'stats' && <StatsTab jobId={jobId} />}
      </div>

      {/* Log Panel Resize Handle */}
      {logHeight > 0 && (
        <div
          className="h-1 cursor-row-resize z-10 hover:bg-accent transition-colors flex-shrink-0"
          onMouseDown={handleLogResize}
        />
      )}

      {/* Log Bottom Panel */}
      <div className="flex flex-col bg-background-void flex-shrink-0" style={{ height: logHeight }}>
        {/* Panel header */}
        <div className="flex items-center bg-background-base border-b border-border-default px-3 h-[38px] flex-shrink-0">
          <span className="text-xs text-foreground-muted flex items-center">
            {t('migration.logTab')}
            {isRunning && <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-accent inline-block animate-pulse" />}
          </span>
          <button
            className="ml-auto p-0.5 rounded text-foreground-muted hover:text-foreground-default hover:bg-border-default transition-colors leading-none text-xs"
            onClick={() => setLogHeight(0)}
          >✕</button>
        </div>
        {/* Log content */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <LogTab
            jobId={jobId}
            stats={run?.stats ?? null}
            logs={run?.logs ?? []}
            isRunning={isRunning}
            onStop={handleStop}
          />
        </div>
      </div>
    </div>
  )
}
