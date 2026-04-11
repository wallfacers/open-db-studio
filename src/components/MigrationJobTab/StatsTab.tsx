import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { MigrationRunHistory } from '../../store/migrationStore'
import { RunHistoryTable } from './ResultPanel/RunHistoryTable'

interface Props { jobId: number }

export function StatsTab({ jobId }: Props) {
  const [history, setHistory] = useState<MigrationRunHistory[]>([])

  useEffect(() => {
    invoke<MigrationRunHistory[]>('get_migration_run_history', { jobId })
      .then(setHistory)
      .catch(() => {})
  }, [jobId])

  return <RunHistoryTable jobId={jobId} history={history} />
}
