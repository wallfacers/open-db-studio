import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy } from 'lucide-react'
import { MigrationLogEvent } from '../../store/migrationStore'
import { formatDateTime } from '../../utils/migrationLogParser'
import { BaseModal } from '../common/BaseModal'

interface Props {
  logs: MigrationLogEvent[]
  onClose: () => void
}

const LEVEL_COLORS: Record<string, string> = {
  SYSTEM: 'text-foreground-muted',
  ERROR: 'text-error',
  WARN: 'text-warning',
  DDL: 'text-accent',
}

export function LogDetailModal({ logs, onClose }: Props) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(false), 2000)
      return () => clearTimeout(timer)
    }
  }, [copied])

  const logsText = useMemo(
    () => logs.map(l => `[${l.timestamp}] ${l.level}: ${l.message}`).join('\n'),
    [logs]
  )

  const handleCopy = () => {
    navigator.clipboard.writeText(logsText).then(() => setCopied(true)).catch(() => {})
  }

  const title = useMemo(() => (
    <>
      {t('migration.logDetailTitle')}
      {copied ? (
        <span className="text-foreground-muted text-xs px-2 py-1">
          {t('migration.logDetailCopied')}
        </span>
      ) : (
        <button
          onClick={handleCopy}
          className="p-1 hover:bg-background-hover rounded text-foreground-muted hover:text-foreground-default transition-colors"
          title={t('common.copy')}
        >
          <Copy size={14} />
        </button>
      )}
    </>
  ), [copied, t, handleCopy])

  return (
    <BaseModal
      title={title}
      onClose={onClose}
      width={720}
      className="max-h-[75vh]"
      footerButtons={[{ label: t('common.close'), onClick: onClose, variant: 'secondary' }]}
    >
      <div className="font-mono text-[11px] leading-relaxed">
        {logs.length > 0 ? (
          logs.map((log, i) => (
            <div key={i} className="py-0.5 whitespace-pre-wrap">
              <span className="text-foreground-subtle">[{formatDateTime(log.timestamp)}]</span>{' '}
              <span className={LEVEL_COLORS[log.level] ?? 'text-foreground-muted'}>{log.level}</span>{' '}
              <span className="text-foreground-default">{log.message}</span>
            </div>
          ))
        ) : (
          <div className="text-foreground-muted text-center py-8">
            {t('migration.noLogs')}
          </div>
        )}
      </div>
    </BaseModal>
  )
}
