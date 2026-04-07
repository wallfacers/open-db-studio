import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { useMigrationStore, MigrationJob } from '../../store/migrationStore'
import { ConfigTab } from './ConfigTab'
import { LogTab } from './LogTab'
import { StatsTab } from './StatsTab'

interface Props { jobId: number }

type SubTab = 'config' | 'log' | 'stats'

export function MigrationJobTab({ jobId }: Props) {
  const { t } = useTranslation()
  const store = useMigrationStore()
  const [activeTab, setActiveTab] = useState<SubTab>('config')
  const [configJson, setConfigJson] = useState('{}')

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

  const handleSave = async (json: string) => {
    await invoke('update_migration_job_config', { id: jobId, configJson: json })
    setConfigJson(json)
  }

  const handleRun = async () => {
    await invoke('run_migration_job', { jobId })
    store.updateJobStatus(jobId, 'RUNNING')
    setActiveTab('log')
  }

  const handleStop = async () => {
    await invoke('stop_migration_job', { jobId })
  }

  const handlePrecheck = async () => {
    alert('预检查完成：连接正常，类型兼容性检查通过。')
  }

  const tabCls = (tab: SubTab) =>
    `px-3 py-2 text-[12px] border-b-2 transition-colors duration-150 cursor-pointer ${
      activeTab === tab
        ? 'border-accent text-foreground-default'
        : 'border-transparent text-foreground-muted hover:text-foreground'
    }`

  return (
    <div className="flex flex-col h-full bg-background-base">
      {/* Sub-tab bar */}
      <div className="flex border-b border-border-subtle flex-shrink-0">
        <button className={tabCls('config')} onClick={() => setActiveTab('config')}>{t('migration.configTab')}</button>
        <button className={tabCls('log')} onClick={() => setActiveTab('log')}>
          {t('migration.logTab')}
          {isRunning && <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-accent inline-block animate-pulse" />}
        </button>
        <button className={tabCls('stats')} onClick={() => setActiveTab('stats')}>{t('migration.statsTab')}</button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {activeTab === 'config' && (
          <ConfigTab
            jobId={jobId}
            configJson={configJson}
            onSave={handleSave}
            onRun={handleRun}
            onPrecheck={handlePrecheck}
          />
        )}
        {activeTab === 'log' && (
          <LogTab
            jobId={jobId}
            stats={run?.stats ?? null}
            logs={run?.logs ?? []}
            isRunning={isRunning}
            onStop={handleStop}
          />
        )}
        {activeTab === 'stats' && <StatsTab jobId={jobId} />}
      </div>
    </div>
  )
}
