import { CheckCircle2, XCircle, Loader2, Circle, ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { MigrationMilestone, MigrationStatsEvent } from '../../store/migrationStore'

interface Props {
  milestones: MigrationMilestone[]
  stats: MigrationStatsEvent | null
}

export function TimelineView({ milestones, stats }: Props) {
  const { t } = useTranslation()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (milestones.length === 0) {
    return (
      <div className="flex items-center justify-center h-24 text-foreground-muted text-xs">
        {t('migration.noRunHistory')}
      </div>
    )
  }

  const toggleExpand = (id: string) => {
    setExpandedId(prev => prev === id ? null : id)
  }

  return (
    <div className="px-3 py-2">
      <div className="relative">
        {/* Vertical connecting line */}
        <div className="absolute left-3 top-4 bottom-4 w-px bg-border-subtle" />

        <div className="space-y-1">
          {milestones.map((m, i) => {
            const isExpanded = expandedId === m.id
            const isLast = i === milestones.length - 1

            return (
              <div key={m.id} className="relative">
                <button
                  onClick={() => (m.type === 'table_start' || m.type === 'table_complete' || m.type === 'table_failed') && toggleExpand(m.id)}
                  className={`flex items-start gap-3 w-full text-left pl-0 py-1 rounded hover:bg-background-elevated/50 transition-colors ${(m.type === 'table_start' || m.type === 'table_complete' || m.type === 'table_failed') ? 'cursor-pointer' : 'cursor-default'}`}
                >
                  {/* Status icon */}
                  <div className="relative z-10 flex-shrink-0 mt-0.5 w-6 h-6 flex items-center justify-center bg-background-base">
                    {m.status === 'success' && <CheckCircle2 size={16} className="text-success" />}
                    {m.status === 'failed' && <XCircle size={16} className="text-error" />}
                    {m.status === 'running' && <Loader2 size={16} className="text-accent animate-spin" />}
                    {m.status === 'pending' && <Circle size={14} className="text-foreground-ghost" />}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      {(m.type === 'table_start' || m.type === 'table_complete' || m.type === 'table_failed') && (
                        <span className="text-foreground-ghost flex-shrink-0">
                          {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                        </span>
                      )}
                      <span className={`text-xs truncate ${
                        m.status === 'failed' ? 'text-error' :
                        m.status === 'running' ? 'text-accent font-medium' :
                        'text-foreground-default'
                      }`}>
                        {m.label}
                      </span>
                      {m.mappingIndex && m.totalMappings && (
                        <span className="text-[10px] text-foreground-ghost flex-shrink-0">
                          [{m.mappingIndex}/{m.totalMappings}]
                        </span>
                      )}
                    </div>

                    {/* Sub-info row */}
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-foreground-ghost">
                        {formatTimestamp(m.timestamp)}
                      </span>
                      {m.elapsedMs !== undefined && (
                        <span className="text-[10px] text-foreground-muted">
                          {t('migration.elapsed')} {formatElapsed(m.elapsedMs)}
                        </span>
                      )}
                      {m.rowsWritten !== undefined && m.type !== 'pipeline_start' && (
                        <span className="text-[10px] text-foreground-muted">
                          {t('migration.rowsWritten')} {m.rowsWritten.toLocaleString()}
                        </span>
                      )}
                      {m.rowsFailed !== undefined && m.rowsFailed > 0 && (
                        <span className="text-[10px] text-error">
                          {m.rowsFailed} failed
                        </span>
                      )}
                      {m.error && (
                        <span className="text-[10px] text-error truncate" title={m.error}>
                          {m.error}
                        </span>
                      )}
                    </div>
                  </div>
                </button>

                {/* Expanded details */}
                {isExpanded && (m.type === 'table_complete' || m.type === 'table_failed') && (
                  <div className="ml-9 mt-1 mb-1 p-2 bg-background-elevated rounded text-[10px] space-y-0.5">
                    <div className="text-foreground-muted">
                      {t('migration.rowsWritten')}: <span className="text-foreground-default font-medium">{m.rowsWritten?.toLocaleString() ?? 0}</span>
                    </div>
                    <div className="text-foreground-muted">
                      Failed: <span className={m.rowsFailed ? 'text-error font-medium' : 'text-foreground-default'}>{m.rowsFailed ?? 0}</span>
                    </div>
                    {m.elapsedMs !== undefined && (
                      <div className="text-foreground-muted">
                        {t('migration.elapsed')}: <span className="text-foreground-default">{formatElapsed(m.elapsedMs)}</span>
                      </div>
                    )}
                    {m.error && (
                      <div className="text-error mt-1 font-mono break-all">{m.error}</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const min = Math.floor(sec / 60)
  const rem = (sec % 60).toFixed(0)
  return `${min}m${rem}s`
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}
