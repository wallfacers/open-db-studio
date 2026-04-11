import { useTranslation } from 'react-i18next'
import { Play, Square, FileEdit, Sparkles } from 'lucide-react'
import { Tooltip } from '../common/Tooltip'

interface Props {
  isRunning: boolean
  ghostTextEnabled: boolean
  onRun: () => void
  onStop: () => void
  onFormat: () => void
  onToggleGhostText: () => void
}

export function MigrationToolbar({
  isRunning,
  ghostTextEnabled,
  onRun,
  onStop,
  onFormat,
  onToggleGhostText,
}: Props) {
  const { t } = useTranslation()

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
