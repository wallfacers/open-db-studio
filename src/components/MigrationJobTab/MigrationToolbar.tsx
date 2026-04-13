import { useTranslation } from 'react-i18next'
import { Play, Square, FileEdit, Sparkles, History, Loader2 } from 'lucide-react'
import { Tooltip } from '../common/Tooltip'

interface Props {
  jobId: number
  isRunning: boolean
  isStopping: boolean
  ghostTextEnabled: boolean
  onRun: () => void
  onStop: () => void
  onFormat: () => void
  onToggleGhostText: () => void
  onOpenHistory: () => void
}

export function MigrationToolbar({
  isRunning,
  isStopping,
  ghostTextEnabled,
  onRun,
  onStop,
  onFormat,
  onToggleGhostText,
  onOpenHistory,
}: Props) {
  const { t } = useTranslation()

  return (
    <div className="flex-shrink-0 h-10 flex items-center px-3 gap-1 bg-background-void border-b border-border-default">
      {/* Run / Stop */}
      <Tooltip content={isStopping ? t('migration.stopping') : isRunning ? t('migration.stop') : t('migration.run')}>
        <button
          className={`p-1.5 rounded transition-colors ${
            isStopping
              ? 'text-foreground-muted cursor-not-allowed'
              : isRunning
                ? 'text-error hover:bg-border-default'
                : 'text-accent hover:bg-border-default'
          }`}
          onClick={isStopping ? undefined : isRunning ? onStop : onRun}
          disabled={isStopping}
        >
          {isStopping
            ? <Loader2 size={16} className="animate-spin" />
            : isRunning
              ? <Square size={16} />
              : <Play size={16} />
          }
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
          onClick={onOpenHistory}
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

    </div>
  )
}
