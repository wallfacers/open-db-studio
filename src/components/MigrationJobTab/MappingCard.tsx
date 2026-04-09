import { CheckCircle2, XCircle, Loader2, Circle, ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { MappingCardState, MigrationLogEvent } from '../../store/migrationStore'

interface Props {
  card: MappingCardState
  logs: MigrationLogEvent[]
}

const BORDER_COLORS: Record<string, string> = {
  success: 'border-l-success',
  running: 'border-l-accent',
  failed: 'border-l-error',
  pending: 'border-l-foreground-ghost',
}

const STATUS_BG: Record<string, string> = {
  success: 'bg-success/10 text-success',
  running: 'bg-accent/10 text-accent',
  failed: 'bg-error/10 text-error',
  pending: 'bg-foreground-ghost/10 text-foreground-ghost',
}

export function MappingCard({ card, logs }: Props) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const statusLabel = card.status === 'success'
    ? t('migration.tableComplete')
    : card.status === 'failed'
      ? t('migration.tableFailed')
      : card.status === 'running'
        ? t('migration.running')
        : t('migration.pending')

  // Gather logs for this specific table mapping
  const tableLogs = logs.filter(l =>
    l.message.includes(card.sourceTable) || l.message.includes(card.targetTable)
  ).slice(-50)

  return (
    <div className={`border-l-2 ${BORDER_COLORS[card.status]} bg-background-elevated rounded-r-md overflow-hidden`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-background-elevated/80 transition-colors text-left"
      >
        {/* Status icon */}
        <div className="flex-shrink-0">
          {card.status === 'success' && <CheckCircle2 size={14} className="text-success" />}
          {card.status === 'failed' && <XCircle size={14} className="text-error" />}
          {card.status === 'running' && <Loader2 size={14} className="text-accent animate-spin" />}
          {card.status === 'pending' && <Circle size={12} className="text-foreground-ghost" />}
        </div>

        {/* Table names */}
        <div className="flex-1 min-w-0">
          <div className="text-xs text-foreground-default truncate">
            {card.sourceTable} <span className="text-foreground-muted">→</span> {card.targetTable}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${STATUS_BG[card.status]}`}>
              {statusLabel}
            </span>
            {card.mappingIndex && card.totalMappings && (
              <span className="text-[10px] text-foreground-ghost">
                [{card.mappingIndex}/{card.totalMappings}]
              </span>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="flex-shrink-0 text-right text-[10px] text-foreground-muted space-x-2">
          <span>{card.rowsWritten.toLocaleString()} <span className="text-foreground-ghost">w</span></span>
          {card.rowsFailed > 0 && <span className="text-error">{card.rowsFailed} <span className="text-foreground-ghost">f</span></span>}
          {card.elapsedMs !== undefined && <span>{formatElapsed(card.elapsedMs)}</span>}
          {card.startedAt && <span className="text-foreground-ghost">{formatTimestamp(card.startedAt)}</span>}
        </div>

        {/* Expand chevron */}
        <div className="flex-shrink-0 text-foreground-ghost">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </div>
      </button>

      {/* Expanded error / logs */}
      {expanded && (
        <div className="px-3 pb-2 space-y-1">
          {card.error && (
            <div className="text-[10px] text-error font-mono break-all bg-error/5 rounded px-2 py-1">
              {card.error}
            </div>
          )}
          {tableLogs.length > 0 && (
            <div className="font-mono text-[10px] text-foreground-muted bg-background-base rounded p-1.5 max-h-32 overflow-y-auto">
              {tableLogs.map((log, i) => (
                <div key={i} className="leading-4">
                  <span className="text-foreground-ghost">[{log.level}]</span> {log.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
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
