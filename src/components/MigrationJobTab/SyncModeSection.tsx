import { useTranslation } from 'react-i18next'
import { DropdownSelect } from '../common/DropdownSelect'

interface IncrementalConfig {
  field: string
  fieldType: 'timestamp' | 'numeric'
  lastValue?: string
}

interface Props {
  syncMode: 'full' | 'incremental'
  incrementalConfig?: IncrementalConfig
  onChange: (syncMode: 'full' | 'incremental', incrementalConfig?: IncrementalConfig) => void
}

export function SyncModeSection({ syncMode, incrementalConfig, onChange }: Props) {
  const { t } = useTranslation()

  const inputCls = "bg-background-elevated border border-border-strong rounded px-2 py-1 text-[12px] text-foreground-default outline-none focus:border-border-focus transition-colors"

  return (
    <div className="bg-background-panel border border-border-subtle rounded p-3">
      <div className="flex items-center gap-3">
        <span className="text-[11px] text-foreground-muted uppercase tracking-wide">{t('migration.syncMode')}</span>
        <DropdownSelect
          value={syncMode}
          onChange={val => {
            const mode = val as 'full' | 'incremental'
            onChange(mode, mode === 'incremental'
              ? (incrementalConfig ?? { field: '', fieldType: 'timestamp' })
              : undefined)
          }}
          options={[
            { value: 'full', label: t('migration.fullSync') },
            { value: 'incremental', label: t('migration.incrementalSync') },
          ]}
          className="w-40"
        />
      </div>

      {syncMode === 'incremental' && incrementalConfig && (
        <div className="mt-2 grid grid-cols-3 gap-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-foreground-subtle">{t('migration.incrementalField')}</span>
            <input
              value={incrementalConfig.field}
              onChange={e => onChange(syncMode, { ...incrementalConfig, field: e.target.value })}
              placeholder="updated_at"
              className={inputCls + " w-full"}
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-foreground-subtle">{t('migration.fieldType')}</span>
            <DropdownSelect
              value={incrementalConfig.fieldType}
              onChange={val => onChange(syncMode, { ...incrementalConfig, fieldType: val as 'timestamp' | 'numeric' })}
              options={[
                { value: 'timestamp', label: 'Timestamp' },
                { value: 'numeric', label: 'Numeric (ID)' },
              ]}
              className="w-full"
            />
          </label>
          {incrementalConfig.lastValue && (
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-foreground-subtle">{t('migration.lastCheckpoint')}</span>
              <input value={incrementalConfig.lastValue} readOnly className={inputCls + " w-full opacity-60"} />
            </label>
          )}
        </div>
      )}
    </div>
  )
}
