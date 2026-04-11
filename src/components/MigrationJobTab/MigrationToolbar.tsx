import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { Play, Square, FileEdit, Sparkles, History } from 'lucide-react'
import { Tooltip } from '../common/Tooltip'
import { BaseModal } from '../common/BaseModal'
import { MigrationRunHistory } from '../../store/migrationStore'
import { RunHistoryTable } from './ResultPanel/RunHistoryTable'

interface Props {
  jobId: number
  isRunning: boolean
  ghostTextEnabled: boolean
  onRun: () => void
  onStop: () => void
  onFormat: () => void
  onToggleGhostText: () => void
}

export function MigrationToolbar({
  jobId,
  isRunning,
  ghostTextEnabled,
  onRun,
  onStop,
  onFormat,
  onToggleGhostText,
}: Props) {
  const { t } = useTranslation()
  const [historyModalOpen, setHistoryModalOpen] = useState(false)
  const [history, setHistory] = useState<MigrationRunHistory[]>([])

  const openHistory = () => {
    invoke<MigrationRunHistory[]>('get_migration_run_history', { jobId })
      .then(setHistory)
      .catch(() => setHistory([]))
      .then(() => setHistoryModalOpen(true))
  }

  return (
    <div className="flex-shrink-0 h-10 flex items-center px-3 gap-1 bg-background-void border-b border-border-default">
      {/* Run / Stop */}
      <Tooltip content={isRunning ? t('migration.stop') : t('migration.run')}>
        <button
          className={`p-1.5 rounded transition-colors ${
            isRunning
              ? 'text-error hover:bg-border-default'
              : 'text-accent hover:bg-border-default'
          }`}
          onClick={isRunning ? onStop : onRun}
        >
          {isRunning ? <Square size={16} /> : <Play size={16} />}
        </button>
      </Tooltip>

      {/* Format */}
      <Tooltip content={t('migration.format')}>
        <button
          className="p-1.5 rounded transition-colors text-foreground-muted hover:text-foreground-default hover:bg-border-default"
          onClick={onFormat}
        >
          <FileEdit size={16} />
        </button>
      </Tooltip>

      {/* Run History */}
      <Tooltip content={t('migration.statsTab')}>
        <button
          className="p-1.5 rounded transition-colors text-foreground-muted hover:text-foreground-default hover:bg-border-default"
          onClick={openHistory}
        >
          <History size={16} />
        </button>
      </Tooltip>

      {/* Ghost Text toggle */}
      <Tooltip content={t('migration.ghostText')}>
        <button
          className={`p-1.5 rounded transition-colors ${
            ghostTextEnabled
              ? 'text-accent hover:bg-border-default'
              : 'text-foreground-muted hover:text-foreground-default hover:bg-border-default'
          }`}
          onClick={onToggleGhostText}
        >
          <Sparkles size={16} />
        </button>
      </Tooltip>

      {/* Run History Modal */}
      {historyModalOpen && (
        <BaseModal
          title={t('migration.statsTab')}
          onClose={() => setHistoryModalOpen(false)}
          width={1100}
          closeOnBackdrop
        >
          <div className="h-[400px]">
            <RunHistoryTable jobId={jobId} history={history} />
          </div>
        </BaseModal>
      )}
    </div>
  )
}
