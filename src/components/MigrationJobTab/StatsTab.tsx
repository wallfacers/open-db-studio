import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Download, CheckCircle2, XCircle } from 'lucide-react'
import { MigrationRunHistory, MigrationDirtyRecord } from '../../store/migrationStore'

interface Props { jobId: number }

export function StatsTab({ jobId }: Props) {
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
  }, [selectedRun])

  const fmtBytes = (b: number) => b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`
  const fmtDur = (ms: number | null) => ms == null ? '-' : ms > 60000 ? `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`

  const run = selectedRun

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

  if (!run) return (
    <div className="flex items-center justify-center h-full text-foreground-muted text-[13px]">
      暂无运行记录
    </div>
  )

  const isSuccess = run.status === 'FINISHED'

  return (
    <div className="p-4 overflow-y-auto h-full flex flex-col gap-4">
      {/* Run selector */}
      {history.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-foreground-muted">历史记录：</span>
          <select
            value={run.runId}
            onChange={e => setSelectedRun(history.find(h => h.runId === e.target.value) ?? null)}
            className="bg-background-elevated border border-border-strong rounded px-2 py-1 text-[11px] text-foreground-default outline-none"
          >
            {history.map(h => <option key={h.runId} value={h.runId}>{h.startedAt} — {h.status}</option>)}
          </select>
        </div>
      )}

      {/* Summary */}
      <div className="bg-background-panel border border-border-subtle rounded p-3">
        <div className="flex items-center gap-2 mb-3">
          {isSuccess
            ? <CheckCircle2 size={16} className="text-success" />
            : <XCircle size={16} className="text-error" />}
          <span className="text-[13px] font-medium text-foreground-default">
            {isSuccess ? '成功' : run.status}
          </span>
          <span className="text-[11px] text-foreground-muted ml-2">耗时 {fmtDur(run.durationMs)}</span>
          <span className="text-[11px] text-foreground-subtle ml-auto">{run.startedAt}</span>
        </div>

        <div className="grid grid-cols-4 gap-2">
          {([
            ['读取行数', run.rowsRead.toLocaleString(), ''],
            ['写入行数', run.rowsWritten.toLocaleString(), ''],
            ['失败行数', run.rowsFailed.toString(), run.rowsFailed > 0 ? 'text-error' : ''],
            ['传输大小', fmtBytes(run.bytesTransferred), ''],
          ] as [string, string, string][]).map(([label, val, cls]) => (
            <div key={label} className="bg-background-elevated border border-border-subtle rounded p-2 text-center">
              <div className="text-[10px] text-foreground-subtle mb-1">{label}</div>
              <div className={`text-[15px] font-semibold text-foreground-default ${cls}`}>{val}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Dirty records */}
      {dirty.length > 0 && (
        <div className="bg-background-panel border border-border-subtle rounded p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] font-medium text-foreground-default">脏数据记录 ({dirty.length})</span>
            <button onClick={handleExportCsv} className="flex items-center gap-1 text-[11px] text-foreground-muted hover:text-foreground transition-colors duration-150">
              <Download size={12} />导出 CSV
            </button>
          </div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {dirty.map(d => (
              <div key={d.id} className="text-[11px] text-foreground-muted bg-background-elevated rounded px-2 py-1 font-mono">
                <span className="text-error">#{d.rowIndex ?? '?'}</span>
                {d.fieldName && <span> | {d.fieldName}</span>}
                {d.rawValue && <span> | "{d.rawValue}"</span>}
                {d.errorMsg && <span className="text-warning"> → {d.errorMsg}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
