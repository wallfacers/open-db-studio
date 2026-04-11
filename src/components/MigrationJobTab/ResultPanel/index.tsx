import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListTree, Code, BarChart2 } from 'lucide-react'
import { Tooltip } from '../../common/Tooltip'
import { LogTab } from '../LogTab'
import { StatsTab } from '../StatsTab'
import { MigrationStatsEvent, MigrationLogEvent, LogViewMode } from '../../../store/migrationStore'

type PanelTab = 'logs' | 'stats'

interface Props {
  jobId: number
  isRunning: boolean
  hasFailed: boolean
  stats: MigrationStatsEvent | null
  logs: MigrationLogEvent[]
  height: number
  onResize: (e: React.MouseEvent) => void
  onClose: () => void
}

export function ResultPanel({
  jobId,
  isRunning,
  hasFailed,
  stats,
  logs,
  height,
  onResize,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<PanelTab>('logs')
  const [viewMode, setViewMode] = useState<LogViewMode>('structured')

  const tabCls = (tab: PanelTab) =>
    `px-3 h-[38px] flex items-center gap-1.5 text-xs cursor-pointer flex-shrink-0 pt-[1px] border-r border-r-border-default transition-colors ${
      activeTab === tab
        ? 'border-t-[3px] border-t-accent bg-background-void text-accent'
        : 'border-t-[3px] border-t-transparent text-foreground-muted hover:text-foreground-default'
    }`

  return (
    <div className="flex flex-col bg-background-void flex-shrink-0 relative border-t border-border-default" style={{ height }}>
      {/* Drag handle */}
      <div
        className="absolute left-0 right-0 top-[-2px] h-[4.5px] cursor-row-resize hover:bg-accent z-10 transition-colors"
        onMouseDown={onResize}
      />

      {/* Tab bar */}
      <div className="flex items-center bg-background-base border-b border-border-default flex-shrink-0 overflow-x-auto">
        <button className={tabCls('logs')} onClick={() => setActiveTab('logs')}>
          <span>{t('migration.logTab')}</span>
          {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />}
        </button>
        <button className={tabCls('stats')} onClick={() => setActiveTab('stats')}>
          <BarChart2 size={12} />
          <span>{t('migration.statsTab')}</span>
        </button>

        {/* Close + view mode controls (shown only for logs tab) */}
        <div className="ml-auto flex items-center gap-1 px-2 flex-shrink-0">
          {activeTab === 'logs' && (
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
          )}
          <Tooltip content={t('common.close', { defaultValue: 'Close' })}>
            <span
              className="hover:bg-border-default rounded p-0.5 leading-none transition-colors duration-200 cursor-pointer text-foreground-muted hover:text-foreground-default"
              onClick={onClose}
            >
              ✕
            </span>
          </Tooltip>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === 'logs' && (
          <LogTab
            jobId={jobId}
            stats={stats}
            logs={logs}
            viewMode={viewMode}
            hasFailed={hasFailed}
          />
        )}
        {activeTab === 'stats' && <StatsTab jobId={jobId} />}
      </div>
    </div>
  )
}
