import { useRef, useEffect } from 'react'
import { Square, Download } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { MigrationLogEvent, MigrationStatsEvent } from '../../store/migrationStore'

interface Props {
  jobId: number
  stats: MigrationStatsEvent | null
  logs: MigrationLogEvent[]
  isRunning: boolean
  onStop: () => void
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

export function LogTab({ stats, logs, isRunning, onStop }: Props) {
  const { t } = useTranslation()
  const logEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs.length])

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
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] text-foreground-muted uppercase tracking-wide">{t('migration.realtimeProgress')}</span>
          {isRunning && (
            <button
              onClick={onStop}
              className="flex items-center gap-1 px-2 py-1 text-[11px] border border-error text-error rounded hover:bg-error-subtle transition-colors duration-150"
            >
              <Square size={10} fill="currentColor" />{t('migration.stop')}
            </button>
          )}
        </div>

        {stats && (<>
          {/* Progress bar */}
          <div className="h-1.5 bg-background-elevated rounded mb-2 overflow-hidden">
            <div className="h-full bg-accent transition-all duration-500 rounded" style={{ width: `${pct}%` }} />
          </div>

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
              <span className="text-accent">{Math.round(stats.writeSpeedRps).toLocaleString()} r/s</span>
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

      {/* Log output */}
      <div className="flex-1 overflow-y-auto p-2 font-mono text-[11px] bg-background-base">
        {logs.map((log, i) => (
          <div key={i} className={`leading-5 ${LOG_COLORS[log.level] ?? 'text-foreground-muted'}`}>
            <span className="text-foreground-ghost mr-1">[{log.level}]</span>
            {log.message}
          </div>
        ))}
        <div ref={logEndRef} />
      </div>

      {/* Footer */}
      <div className="flex justify-end p-2 border-t border-border-subtle flex-shrink-0">
        <button onClick={handleExport} className="flex items-center gap-1.5 text-[11px] text-foreground-muted hover:text-foreground transition-colors duration-150">
          <Download size={12} />{t('migration.exportLog')}
        </button>
      </div>
    </div>
  )
}
