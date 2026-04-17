import { useEffect, useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { MigrationRunHistory } from '../../store/migrationStore'
import { RunHistoryTable } from './ResultPanel/RunHistoryTable'

interface Props { jobId: number }

export function StatsTab({ jobId }: Props) {
  const [history, setHistory] = useState<MigrationRunHistory[]>([])

  const fetchHistory = useCallback(() => {
    invoke<MigrationRunHistory[]>('get_migration_run_history', { jobId })
      .then(setHistory)
      .catch(() => {})
  }, [jobId])

  useEffect(() => {
    fetchHistory()
  }, [jobId, fetchHistory])

  return <RunHistoryTable jobId={jobId} history={history} onRefresh={fetchHistory} />
}
