import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Download, CheckCircle2, XCircle, Clock, AlertCircle, StopCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { MigrationRunHistory, MigrationDirtyRecord } from '../../store/migrationStore'

interface Props { jobId: number }

function statusIcon(status: string) {
  switch (status) {
    case 'FINISHED': return <CheckCircle2 size={14} className="text-success flex-shrink-0" />
    case 'FAILED': return <XCircle size={14} className="text-error flex-shrink-0" />
    case 'STOPPED': return <StopCircle size={14} className="text-foreground-muted flex-shrink-0" />
    default: return <AlertCircle size={14} className="text-warning flex-shrink-0" />
  }
}

function fmtBytes(b: number): string {
  if (b <= 0) return '0 B'
  if (b > 1e9) return `${(b / 1e9).toFixed(2)} GB`
  if (b > 1e6) return `${(b / 1e6).toFixed(1)} MB`
  if (b > 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${b} B`
}

function fmtDur(ms: number | null): string {
  if (ms == null || ms <= 0) return '-'
  if (ms > 60000) return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`
  return `${(ms / 1000).toFixed(1)}s`
}

function statusLabel(status: string, t: (key: string) => string): string {
  if (status === 'FINISHED') return t('migration.success')
  return status
}

export function StatsTab({ jobId }: Props) {
  const { t } = useTranslation()
  const [history, setHistory] = useState<MigrationRunHistory[]>([])
  const [dirty, setDirty] = useState<MigrationDirtyRecord[]>([])
  const [selectedRun, setSelectedRun] = useState<MigrationRunHistory | null>(null)

  useEffect(() => {
    invoke<MigrationRunHistory[]>('get_migration_run_history', { jobId })
      .then(h => { setHistory(h); if (h.length) setSelectedRun(h[0]) })
      .catch(() => {})
  }, [jobId])

  useEffect(() => {
    if (!selectedRun) return
    invoke<MigrationDirtyRecord[]>('get_migration_dirty_records', { jobId, runId: selectedRun.runId })
      .then(setDirty).catch(() => {})
  }, [selectedRun?.runId, jobId])

  const handleExportCsv = () => {
    if (!dirty.length) return
    const header = 'row_index,field_name,raw_value,error_msg\n'
    const rows = dirty.map(d => `${d.rowIndex ?? ''},${d.fieldName ?? ''},${JSON.stringify(d.rawValue ?? '')},${JSON.stringify(d.errorMsg ?? '')}`).join('\n')
    const blob = new Blob([header + rows], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `dirty_records_job${jobId}_${Date.now()}.csv`
    a.click()
  }

  // ── No history ──
  if (!history.length) return (
    <div className="flex items-center justify-center h-full text-foreground-muted text-[13px]">
      {t('migration.noRunHistory')}
    </div>
  )

  const run = selectedRun
  const isSuccess = run?.status === 'FINISHED'

  return (
    <div className="flex h-full">
      {/* Left: history list */}
      <div className="w-56 flex-shrink-0 border-r border-border-subtle flex flex-col bg-background-panel">
        <div className="px-3 py-2 text-[11px] font-medium text-foreground-subtle uppercase tracking-wider border-b border-border-subtle">
          {t('migration.historyLabel')}
        </div>
        <div className="flex-1 overflow-y-auto">
          {history.map(h => {
            const active = selectedRun?.runId === h.runId
            return (
              <button
                key={h.runId}
                onClick={() => setSelectedRun(h)}
                className={`w-full text-left px-3 py-2.5 border-b border-border-subtle/50 transition-colors cursor-pointer ${
                  active
                    ? 'bg-accent/10 border-l-2 border-l-accent'
                    : 'hover:bg-background-elevated/50 border-l-2 border-l-transparent'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  {statusIcon(h.status)}
                  <span className="text-[12px] text-foreground-default font-medium truncate">
                    {statusLabel(h.status, t)}
                  </span>
                </div>
                <div className="text-[10px] text-foreground-muted mt-1 flex items-center gap-1">
                  <Clock size={9} />
                  <span>{h.startedAt}</span>
                </div>
                <div className="text-[10px] text-foreground-subtle mt-0.5">
                  {fmtDur(h.durationMs)} · {(h.rowsWritten ?? 0).toLocaleString()} rows
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Right: detail */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {run && (
          <>
            {/* Summary */}
            <div className="bg-background-elevated border border-border-subtle rounded-lg p-4">
              <div className="flex items-center gap-2 mb-4">
                {isSuccess
                  ? <CheckCircle2 size={18} className="text-success" />
                  : <XCircle size={18} className="text-error" />}
                <span className="text-[14px] font-semibold text-foreground-default">
                  {isSuccess ? t('migration.success') : run.status}
                </span>
                {run.durationMs != null && (
                  <span className="text-[12px] text-foreground-muted ml-2">
                    {t('migration.duration')} {fmtDur(run.durationMs)}
                  </span>
                )}
                <span className="text-[11px] text-foreground-subtle ml-auto">{run.startedAt}</span>
              </div>

              <div className="grid grid-cols-4 gap-3">
                {([
                  [t('migration.rowsReadLabel'), (run.rowsRead ?? 0).toLocaleString(), ''],
                  [t('migration.rowsWrittenLabel'), (run.rowsWritten ?? 0).toLocaleString(), ''],
                  [t('migration.rowsFailedLabel'), (run.rowsFailed ?? 0).toLocaleString(), (run.rowsFailed ?? 0) > 0 ? 'text-error' : ''],
                  [t('migration.bytesTransferred'), fmtBytes(run.bytesTransferred ?? 0), ''],
                ] as [string, string, string][]).map(([label, val, cls]) => (
                  <div key={label} className="bg-background-base border border-border-subtle rounded-lg p-3 text-center">
                    <div className="text-[10px] text-foreground-subtle mb-1.5">{label}</div>
                    <div className={`text-[16px] font-semibold text-foreground-default ${cls}`}>{val}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Dirty records */}
            {dirty.length > 0 && (
              <div className="bg-background-elevated border border-border-subtle rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[13px] font-medium text-foreground-default">
                    {t('migration.dirtyRecords')} ({dirty.length})
                  </span>
                  <button
                    onClick={handleExportCsv}
                    className="flex items-center gap-1.5 text-[12px] text-foreground-muted hover:text-foreground transition-colors"
                  >
                    <Download size={13} />{t('migration.exportCsv')}
                  </button>
                </div>
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {dirty.map(d => (
                    <div key={d.id} className="text-[11px] text-foreground-muted bg-background-base rounded px-2.5 py-1.5 font-mono flex items-center gap-2">
                      <span className="text-error flex-shrink-0">#{d.rowIndex ?? '?'}</span>
                      {d.fieldName && <span className="text-foreground-subtle flex-shrink-0">{d.fieldName}</span>}
                      {d.rawValue && <span className="truncate">"{d.rawValue}"</span>}
                      {d.errorMsg && <span className="text-warning flex-shrink-0 ml-auto">{d.errorMsg}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
