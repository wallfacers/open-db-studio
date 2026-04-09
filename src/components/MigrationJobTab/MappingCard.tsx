import { CheckCircle2, XCircle, Loader2, Circle, ChevronDown, ChevronRight, Database } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { MappingCardState, MigrationLogEvent } from '../../store/migrationStore'

interface Props {
  card: MappingCardState
  logs?: MigrationLogEvent[]
}

const BORDER_COLORS: Record<string, string> = {
  success: 'border-l-success',
  running: 'border-l-accent',
  failed: 'border-l-error',
  pending: 'border-l-foreground-ghost',
}

function NodeStatusIcon({ status, size = 12 }: { status: string; size?: number }) {
  if (status === 'success') return <CheckCircle2 size={size} className="text-success" />
  if (status === 'failed') return <XCircle size={size} className="text-error" />
  if (status === 'running') return <Loader2 size={size} className="text-accent animate-spin" />
  return <Circle size={size - 2} className="text-foreground-ghost" />
}

export function MappingCard({ card, logs = [] }: Props) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  // Determine read node status
  const readStatus = card.status === 'pending' ? 'pending'
    : card.status === 'running' ? 'running'
    : card.status === 'failed' && card.rowsRead === 0 ? 'failed'
    : 'success'

  // Determine write node status
  const writeStatus = card.status === 'pending' ? 'pending'
    : card.status === 'running' ? 'running'
    : card.status === 'failed' ? 'failed'
    : 'success'

  const nodeColor = (status: string) =>
    status === 'success' ? 'bg-success/5 text-success' :
    status === 'failed' ? 'bg-error/5 text-error' :
    status === 'running' ? 'bg-accent/5 text-accent' :
    'bg-foreground-ghost/5 text-foreground-ghost'

  // Gather logs for this specific table mapping
  const tableLogs = logs.filter(l =>
    l.message.includes(card.sourceTable) || l.message.includes(card.targetTable)
  ).slice(-50)

  return (
    <div className={`border-l-2 ${BORDER_COLORS[card.status]} bg-background-elevated rounded-r-md overflow-hidden`}>
      {/* Header: status icon + table names + expand chevron */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-background-elevated/80 transition-colors text-left"
      >
        <div className="flex-shrink-0">
          {card.status === 'success' && <CheckCircle2 size={14} className="text-success" />}
          {card.status === 'failed' && <XCircle size={14} className="text-error" />}
          {card.status === 'running' && <Loader2 size={14} className="text-accent animate-spin" />}
          {card.status === 'pending' && <Circle size={12} className="text-foreground-ghost" />}
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-xs text-foreground-default truncate">
            {card.sourceTable} <span className="text-foreground-muted">→</span> {card.targetTable}
          </div>
        </div>

        {card.mappingIndex && card.totalMappings && (
          <span className="text-[10px] text-foreground-ghost flex-shrink-0">
            [{card.mappingIndex}/{card.totalMappings}]
          </span>
        )}

        <div className="flex-shrink-0 text-foreground-ghost">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </div>
      </button>

      {/* Read/Write nodes */}
      <div className="px-3 pb-1.5 flex items-center gap-2">
        <div className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] ${nodeColor(readStatus)}`}>
          <NodeStatusIcon status={readStatus} size={10} />
          <Database size={10} />
          <span>{t('migration.read')}{card.rowsRead > 0 ? `: ${card.rowsRead.toLocaleString()}` : ''}</span>
        </div>
        <span className="text-[10px] text-foreground-ghost">→</span>
        <div className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] ${nodeColor(writeStatus)}`}>
          <NodeStatusIcon status={writeStatus} size={10} />
          <Database size={10} />
          <span>{t('migration.write')}{card.rowsWritten > 0 ? `: ${card.rowsWritten.toLocaleString()}` : ''}</span>
        </div>
      </div>

      {/* Stats row */}
      <div className="px-3 pb-1.5 text-[10px] text-foreground-muted flex items-center gap-3 flex-wrap">
        {card.startedAt && (
          <span>{t('migration.startedAt')}: <span className="text-foreground-default font-medium">{formatTimestamp(card.startedAt)}</span></span>
        )}
        {card.finishedAt && (
          <span>{t('migration.finishedAt')}: <span className="text-foreground-default font-medium">{formatTimestamp(card.finishedAt)}</span></span>
        )}
        {card.elapsedMs !== undefined && (
          <span>{t('migration.elapsed')}: <span className="text-foreground-default font-medium">{formatElapsed(card.elapsedMs)}</span></span>
        )}
        <span>Failed: <span className={card.rowsFailed > 0 ? 'text-error font-medium' : 'text-foreground-default'}>{card.rowsFailed}</span></span>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-3 pb-2 space-y-1">
          {card.error && (
            <div className="text-[10px] text-error font-mono break-all bg-error/5 rounded px-2 py-1">
              {card.error}
            </div>
          )}
          {/* Table-specific logs */}
          {tableLogs.length > 0 && (
            <div className="text-[10px] font-mono bg-background-base rounded p-2 max-h-32 overflow-y-auto space-y-0.5">
              {tableLogs.map((log, i) => (
                <div key={i} className={`leading-4 ${
                  log.level === 'ERROR' ? 'text-error' :
                  log.level === 'WARN' ? 'text-warning' :
                  log.level === 'DDL' ? 'text-info' :
                  'text-foreground-muted'
                }`}>
                  <span className="text-foreground-ghost mr-1">[{formatTimestamp(log.timestamp)}]</span>
                  <span className="text-foreground-ghost mr-1">[{log.level}]</span>
                  {log.message}
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
