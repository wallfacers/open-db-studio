import { CheckCircle2, XCircle, Loader2, Circle, StopCircle, AlertCircle } from 'lucide-react'

/** Status icon for migration-level job runs (FINISHED, FAILED, etc.). */
export function MigrationStatusIcon({ status, size = 14 }: { status: string; size?: number }) {
  switch (status) {
    case 'FINISHED': return <CheckCircle2 size={size} className="text-success" />
    case 'FAILED':
    case 'PARTIAL_FAILED': return <XCircle size={size} className="text-error" />
    case 'STOPPED': return <StopCircle size={size} className="text-foreground-muted" />
    default: return <AlertCircle size={size} className="text-warning" />
  }
}

/** Status icon for table-level mapping nodes (success, failed, running, pending). */
export function TableStatusIcon({ status, size = 16 }: { status: string; size?: number }) {
  if (status === 'success') return <CheckCircle2 size={size} className="text-success" />
  if (status === 'failed') return <XCircle size={size} className="text-error" />
  if (status === 'running') return <Loader2 size={size} className="text-accent animate-spin" />
  return <Circle size={size - 2} className="text-foreground-ghost" />
}
