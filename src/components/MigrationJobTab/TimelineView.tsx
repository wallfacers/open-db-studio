import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { MigrationMilestone, MigrationStatsEvent } from '../../store/migrationStore'
import { formatElapsed, formatTimestamp } from '../../utils/migrationLogParser'
import { TableStatusIcon } from './StatusIcons'

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

  const translateLabel = (label: string): string => {
    switch (label) {
      case 'pipeline_started': return t('migration.pipelineStarted')
      case 'pipeline_finished': return t('migration.pipelineFinish')
      case 'pipeline_FINISHED': return t('migration.pipelineFinish')
      case 'pipeline_FAILED': return t('migration.pipelineFailed', { status: 'FAILED' })
      case 'pipeline_PARTIAL_FAILED': return t('migration.pipelineFailed', { status: 'PARTIAL_FAILED' })
      case 'notRunUpstreamFailed': return t('migration.notRunUpstreamFailed')
      default: return label
    }
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
                    <TableStatusIcon status={m.status} size={16} />
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
                        {translateLabel(m.label)}
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
                      {m.rowsRead !== undefined && m.type !== 'pipeline_start' && (
                        <span className="text-[10px] text-foreground-muted">
                          {t('migration.rowsRead')} {m.rowsRead.toLocaleString()}
                        </span>
                      )}
                      {m.rowsWritten !== undefined && m.type !== 'pipeline_start' && (
                        <span className="text-[10px] text-foreground-muted">
                          {t('migration.rowsWritten')} {m.rowsWritten.toLocaleString()}
                        </span>
                      )}
                      {m.rowsFailed !== undefined && m.rowsFailed > 0 && (
                        <span className="text-[10px] text-error">
                          {m.rowsFailed} {t('migration.failedShort')}
                        </span>
                      )}
                      {m.error && (
                        <span className="text-[10px] text-error truncate" title={translateLabel(m.error)}>
                          {translateLabel(m.error)}
                        </span>
                      )}
                    </div>
                  </div>
                </button>

                {/* Expanded details */}
                {isExpanded && (m.type === 'table_complete' || m.type === 'table_failed') && (
                  <div className="ml-9 mt-1 mb-1 p-2 bg-background-elevated rounded text-[10px] space-y-0.5">
                    <div className="text-foreground-muted">
                      {t('migration.rowsRead')}: <span className="text-foreground-default font-medium">{m.rowsRead?.toLocaleString() ?? 0}</span>
                    </div>
                    <div className="text-foreground-muted">
                      {t('migration.rowsWritten')}: <span className="text-foreground-default font-medium">{m.rowsWritten?.toLocaleString() ?? 0}</span>
                    </div>
                    <div className="text-foreground-muted">
                      {t('migration.failedLabel')}: <span className={m.rowsFailed ? 'text-error font-medium' : 'text-foreground-default'}>{m.rowsFailed ?? 0}</span>
                    </div>
                    {m.elapsedMs !== undefined && (
                      <div className="text-foreground-muted">
                        {t('migration.elapsed')}: <span className="text-foreground-default">{formatElapsed(m.elapsedMs)}</span>
                      </div>
                    )}
                    {m.error && (
                      <div className="text-error mt-1 font-mono break-all">{translateLabel(m.error)}</div>
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
