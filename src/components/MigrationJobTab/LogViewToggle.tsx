import { ListTree, Code } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LogViewMode } from '../../store/migrationStore'

interface Props {
  mode: LogViewMode
  onChange: (mode: LogViewMode) => void
}

export function LogViewToggle({ mode, onChange }: Props) {
  const { t } = useTranslation()

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border-subtle">
      <div className="flex items-center bg-background-elevated rounded-md p-0.5 text-[11px]">
        <button
          onClick={() => onChange('structured')}
          className={`flex items-center gap-1 px-2 py-1 rounded transition-colors ${
            mode === 'structured'
              ? 'bg-accent text-white'
              : 'text-foreground-muted hover:text-foreground-default'
          }`}
        >
          <ListTree size={12} />
          {t('migration.structuredView')}
        </button>
        <button
          onClick={() => onChange('raw')}
          className={`flex items-center gap-1 px-2 py-1 rounded transition-colors ${
            mode === 'raw'
              ? 'bg-accent text-white'
              : 'text-foreground-muted hover:text-foreground-default'
          }`}
        >
          <Code size={12} />
          {t('migration.rawLog')}
        </button>
      </div>
    </div>
  )
}
