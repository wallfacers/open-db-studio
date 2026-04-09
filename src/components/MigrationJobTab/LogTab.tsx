import { useRef, useEffect, useMemo } from 'react'
import { Download } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { MigrationLogEvent, MigrationStatsEvent, LogViewMode } from '../../store/migrationStore'
import { TimelineView } from './TimelineView'
import { MappingCard } from './MappingCard'
import { parseMilestones, formatTimestamp } from '../../utils/migrationLogParser'

interface Props {
  jobId: number
  stats: MigrationStatsEvent | null
  logs: MigrationLogEvent[]
  viewMode: LogViewMode
  hasFailed?: boolean
}

const LOG_COLORS: Record<string, string> = {
  ERROR: 'text-error',
  WARN: 'text-warning',
  STATS: 'text-accent font-medium',
  DDL: 'text-info',
  SYSTEM: 'text-foreground-muted',
  PRECHECK: 'text-foreground-muted',
  INFO: 'text-foreground-muted',
  PROGRESS: 'text-foreground-muted',
}

export function LogTab({ stats, logs, viewMode, hasFailed }: Props) {
  const { t } = useTranslation()
  const logEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (viewMode === 'raw') {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs.length, viewMode])

  const { milestones, cards } = useMemo(() => parseMilestones(logs), [logs])

  const handleExport = () => {
    const text = logs.map(l => `[${l.timestamp}] [${l.level}] ${l.message}`).join('\n')
    const blob = new Blob([text], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `migration_log_${Date.now()}.txt`
    a.click()
  }

  const pct = stats?.progressPct ?? 0

  return (
    <div className="flex flex-col h-full">
      {/* Stats bar */}
      <div className="p-3 border-b border-border-subtle flex-shrink-0">
        <div className="flex items-center mb-2">
          <span className="text-[11px] text-foreground-muted uppercase tracking-wide">{t('migration.realtimeProgress')}</span>
        </div>

        {stats && (<>
          {/* Progress bar */}
          <div className="h-1.5 bg-background-elevated rounded mb-2 overflow-hidden">
            <div className={`h-full transition-all duration-500 rounded ${hasFailed ? 'bg-error' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
          </div>

          {/* Mapping progress indicator */}
          {stats.currentMapping && stats.mappingProgress && (
            <div className="text-[11px] text-foreground-muted mb-1">
              [{stats.mappingProgress.current}/{stats.mappingProgress.total}] {t('migration.migrating')} {stats.currentMapping} ...
            </div>
          )}

          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <div>
              <span className="text-foreground-subtle">{t('migration.rowsRead')}  </span>
              <span className="text-foreground-default font-medium">{stats.rowsRead.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-foreground-subtle">{t('migration.rowsWritten')}  </span>
              <span className="text-foreground-default font-medium">{stats.rowsWritten.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-foreground-subtle">{t('migration.dirtyRows')}  </span>
              <span className={stats.rowsFailed > 0 ? 'text-error font-medium' : 'text-foreground-default'}>{stats.rowsFailed}</span>
            </div>
            <div>
              <span className="text-foreground-subtle">{t('migration.speed')}  </span>
              <span className={hasFailed ? 'text-error' : 'text-accent'}>{Math.round(stats.writeSpeedRps).toLocaleString()} r/s</span>
            </div>
            {stats.etaSeconds !== null && (
              <div>
                <span className="text-foreground-subtle">{t('migration.eta')}  </span>
                <span className="text-foreground-default">{stats.etaSeconds < 60 ? `${Math.round(stats.etaSeconds)}s` : `${Math.round(stats.etaSeconds / 60)}m${Math.round(stats.etaSeconds % 60)}s`}</span>
              </div>
            )}
            {pct > 0 && (
              <div>
                <span className="text-foreground-default font-medium">{pct.toFixed(1)}%</span>
              </div>
            )}
          </div>
        </>)}
      </div>

      {/* Content area */}
      {viewMode === 'structured' ? (
        <div className="flex-1 overflow-y-auto bg-background-base">
          {/* Timeline */}
          {milestones.length > 0 && <TimelineView milestones={milestones} stats={stats} />}

          {/* Mapping cards */}
          {cards.length > 0 && (
            <div className="px-3 pb-2 space-y-1.5">
              <div className="text-[11px] text-foreground-muted font-medium mt-2 mb-1">
                {t('migration.mappingCards')}
              </div>
              {cards.map((card) => (
                <MappingCard key={`${card.sourceTable}-${card.targetTable}`} card={card} logs={logs} />
              ))}
            </div>
          )}

          {/* Empty state */}
          {milestones.length === 0 && cards.length === 0 && (
            <div className="flex items-center justify-center h-24 text-foreground-muted text-xs">
              {t('migration.noRunHistory')}
            </div>
          )}
        </div>
      ) : (
        /* Raw log output */
        <div className="flex-1 overflow-y-auto p-2 font-mono text-[11px] bg-background-base">
          {logs.map((log, i) => (
            <div key={i} className={`leading-5 ${LOG_COLORS[log.level] ?? 'text-foreground-muted'}`}>
              <span className="text-foreground-ghost mr-1">[{formatTimestamp(log.timestamp)}]</span>
              <span className="text-foreground-ghost mr-1">[{log.level}]</span>
              {log.message}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      )}

      {/* Footer */}
      <div className="flex justify-end p-2 border-t border-border-subtle flex-shrink-0">
        <button onClick={handleExport} className="flex items-center gap-1.5 text-[11px] text-foreground-muted hover:text-foreground transition-colors duration-150">
          <Download size={12} />{t('migration.exportLog')}
        </button>
      </div>
    </div>
  )
}
