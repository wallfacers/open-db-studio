import { useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Trash2, Ellipsis, CircleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { MigrationRunHistory, MigrationLogEvent, useMigrationStore } from '../../../store/migrationStore'
import { LogDetailModal } from '../LogDetailModal'
import { MigrationStatusIcon } from '../StatusIcons'
import { formatDateTime, fmtBytesSpeed, fmtBytes, fmtDuration } from '../../../utils/migrationLogParser'

interface Props { jobId: number; history: MigrationRunHistory[]; onRefresh: () => void }

const PAGE_SIZE = 10

function statusLabel(status: string, t: (key: string) => string): string {
  const map: Record<string, string> = {
    FINISHED: t('migration.statusFinished'),
    FAILED: t('migration.statusFailed'),
    STOPPED: t('migration.statusStopped'),
    RUNNING: t('migration.statusRunning'),
    PARTIAL_FAILED: t('migration.statusFailed'),
  }
  return map[status] || status
}

export function RunHistoryTable({ jobId, history, onRefresh }: Props) {
  const { t } = useTranslation()
  const [page, setPage] = useState(1)
  const [logModalOpen, setLogModalOpen] = useState(false)
  const [selectedLogs, setSelectedLogs] = useState<MigrationLogEvent[]>([])
  const [confirmDelete, setConfirmDelete] = useState<MigrationRunHistory | null>(null)

  const totalPages = Math.max(1, Math.ceil(history.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const paginated = history.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  const handleViewLogs = useCallback((run: MigrationRunHistory) => {
    let logs: MigrationLogEvent[] = []
    if (run.logContent) {
      try { logs = JSON.parse(run.logContent) } catch { logs = [] }
    }
    if (logs.length === 0) {
      const activeRun = useMigrationStore.getState().activeRuns.get(jobId)
      if (activeRun?.runId === run.runId) logs = activeRun.logs
    }
    setSelectedLogs(logs)
    setLogModalOpen(true)
  }, [jobId])

  const handleDelete = useCallback(async (run: MigrationRunHistory) => {
    if (run.status === 'RUNNING') return
    try {
      await invoke('delete_migration_run_history', { jobId, runId: run.runId })
      onRefresh()
    } catch { /* ignore */ }
  }, [jobId, onRefresh])

  const handleConfirmDelete = useCallback(() => {
    if (confirmDelete) {
      handleDelete(confirmDelete)
      setConfirmDelete(null)
    }
  }, [confirmDelete, handleDelete])

  const invalidCount = history.filter(r => r.status === 'FAILED' || r.status === 'STOPPED').length

  const handleClearInvalid = useCallback(async () => {
    if (invalidCount === 0) return
    const toDelete = history.filter(r => r.status === 'FAILED' || r.status === 'STOPPED')
    for (const run of toDelete) {
      try {
        await invoke('delete_migration_run_history', { jobId, runId: run.runId })
      } catch { /* ignore */ }
    }
    onRefresh()
  }, [jobId, history, invalidCount, onRefresh])

  if (!history.length) return (
    <div className="flex items-center justify-center h-full text-foreground-muted text-[13px]">
      {t('migration.noRunHistory')}
    </div>
  )

  return (
    <div className="flex flex-col h-full">
      {invalidCount > 0 && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-subtle bg-background-elevated/20 flex-shrink-0">
          <span className="text-[12px] text-foreground-muted">
            {t('migration.invalidRecords')}: {invalidCount}
          </span>
          <button onClick={handleClearInvalid}
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded text-error hover:text-error hover:bg-background-hover transition-colors"
          >
            <CircleAlert size={12} />
            {t('migration.clearInvalid')}
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 z-10 bg-background-base">
            <tr className="border-b border-border-subtle text-foreground-subtle">
              <th className="text-left px-3 py-2 font-medium">{t('migration.colRecordTime')}</th>
              <th className="text-left px-3 py-2 font-medium">{t('migration.colStatus')}</th>
              <th className="text-right px-3 py-2 font-medium">{t('migration.colRowsRead')}</th>
              <th className="text-right px-3 py-2 font-medium">{t('migration.colRowsWritten')}</th>
              <th className="text-right px-3 py-2 font-medium">{t('migration.colRowsFailed')}</th>
              <th className="text-right px-3 py-2 font-medium">{t('migration.colTransferredSize')}</th>
              <th className="text-right px-3 py-2 font-medium">{t('migration.colDuration')}</th>
              <th className="text-right px-3 py-2 font-medium">{t('migration.colSpeed')}</th>
              <th className="text-center px-3 py-2 font-medium w-20">{t('migration.colLogDetails')}</th>
              <th className="text-center px-3 py-2 font-medium w-16">{t('migration.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map(run => (
              <tr key={run.runId} className="border-b border-border-subtle/50 hover:bg-background-elevated/30 transition-colors">
                <td className="px-3 py-2.5 text-foreground-default font-mono text-[11px]">{formatDateTime(run.startedAt)}</td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <MigrationStatusIcon status={run.status} />
                    <span className="text-foreground-default">{statusLabel(run.status, t)}</span>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-foreground-default">{(run.rowsRead ?? 0).toLocaleString()}</td>
                <td className="px-3 py-2.5 text-right font-mono text-foreground-default">{(run.rowsWritten ?? 0).toLocaleString()}</td>
                <td className={`px-3 py-2.5 text-right font-mono ${(run.rowsFailed ?? 0) > 0 ? 'text-error' : 'text-foreground-muted'}`}>{(run.rowsFailed ?? 0).toLocaleString()}</td>
                <td className="px-3 py-2.5 text-right font-mono text-foreground-default">{fmtBytes(run.bytesTransferred ?? 0)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-foreground-default">
                  {run.durationMs != null && run.durationMs > 0 ? fmtDuration(run.durationMs) : '-'}
                </td>
                <td className="px-3 py-2.5 text-right">
                  {(() => {
                    const durationSec = (run.durationMs ?? 0) / 1000
                    if (durationSec <= 0) return <span className="text-foreground-muted">-</span>
                    const rowsPerSec = (run.rowsWritten ?? 0) / durationSec
                    const bytesPerSec = (run.bytesTransferred ?? 0) / durationSec
                    return (
                      <div className="flex flex-col items-end gap-0">
                        <span className="text-accent text-[11px] font-medium">{Math.round(rowsPerSec).toLocaleString()} {t('migration.rowsPerSec')}</span>
                        <span className="text-accent text-[11px]">{fmtBytesSpeed(bytesPerSec)}</span>
                      </div>
                    )
                  })()}
                </td>
                <td className="px-3 py-2.5 text-center">
                  <button onClick={() => handleViewLogs(run)}
                    className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-background-hover text-foreground-muted hover:text-foreground-default transition-colors"
                    title={t('migration.logDetailTitle')}
                  >
                    <Ellipsis size={14} />
                  </button>
                </td>
                <td className="px-3 py-2.5 text-center">
                  {run.status !== 'RUNNING' && (
                    <button onClick={() => setConfirmDelete(run)}
                      className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-background-hover text-foreground-muted hover:text-error transition-colors"
                      title={t('common.delete')}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-border-subtle bg-background-base flex-shrink-0">
          <span className="text-[11px] text-foreground-muted">{t('migration.total')} {history.length}</span>
          <div className="flex items-center gap-1">
            <button onClick={() => setPage(1)} disabled={safePage === 1}
              className="px-2 py-1 text-[11px] rounded text-foreground-muted hover:text-foreground-default hover:bg-background-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              {t('migration.firstPage')}
            </button>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage === 1}
              className="px-2 py-1 text-[11px] rounded text-foreground-muted hover:text-foreground-default hover:bg-background-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              {t('migration.prevPage')}
            </button>
            <span className="px-2 text-[11px] text-foreground-default min-w-[60px] text-center">{safePage} / {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}
              className="px-2 py-1 text-[11px] rounded text-foreground-muted hover:text-foreground-default hover:bg-background-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              {t('migration.nextPage')}
            </button>
            <button onClick={() => setPage(totalPages)} disabled={safePage === totalPages}
              className="px-2 py-1 text-[11px] rounded text-foreground-muted hover:text-foreground-default hover:bg-background-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
              {t('migration.lastPage')}
            </button>
          </div>
        </div>
      )}

      {logModalOpen && <LogDetailModal logs={selectedLogs} onClose={() => setLogModalOpen(false)} />}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background-base rounded-lg shadow-xl border border-border-subtle p-6 max-w-sm mx-4">
            <p className="text-[14px] text-foreground-default mb-4">{t('migration.deleteRunConfirm')}</p>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setConfirmDelete(null)}
                className="px-3 py-1.5 text-[13px] rounded text-foreground-muted hover:text-foreground-default hover:bg-background-hover transition-colors">
                {t('common.cancel')}
              </button>
              <button onClick={handleConfirmDelete}
                className="px-3 py-1.5 text-[13px] rounded bg-error text-white hover:bg-error/80 transition-colors">
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
