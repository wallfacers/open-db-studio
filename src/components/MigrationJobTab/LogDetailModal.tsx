import { useTranslation } from 'react-i18next'
import { X, Copy, Check } from 'lucide-react'
import { MigrationLogEvent } from '../../store/migrationStore'
import { formatDateTime } from '../../utils/migrationLogParser'
import { useState, useEffect } from 'react'

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
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [onClose])

  const handleCopy = () => {
    const text = logs.map(l => `[${l.timestamp}] ${l.level}: ${l.message}`).join('\n')
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => {})
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-background-panel border border-border-strong rounded-lg shadow-2xl flex flex-col"
        style={{ width: '720px', maxHeight: '75vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-default flex-shrink-0">
          <span className="text-foreground-default text-sm font-medium">
            {t('migration.logDetailTitle', { defaultValue: '运行日志详情' })}
          </span>
          <div className="flex items-center gap-1">
            {copied ? (
              <span className="text-foreground-muted text-xs px-2 py-1.5">
                {t('migration.logDetailCopied', { defaultValue: '已复制' })}
              </span>
            ) : (
              <button
                onClick={handleCopy}
                className="p-1.5 hover:bg-background-hover rounded text-foreground-muted hover:text-foreground-default transition-colors"
                title={t('migration.logDetailCopy', { defaultValue: '复制' })}
              >
                <Copy size={14} />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-background-hover rounded text-foreground-muted hover:text-foreground-default transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Log content */}
        <div className="flex-1 overflow-y-auto p-4 font-mono text-[11px] leading-relaxed">
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
              {t('migration.noLogs', { defaultValue: '无日志内容' })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-4 py-2 border-t border-border-default flex-shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1 text-xs bg-background-hover hover:bg-background-active text-foreground-default rounded transition-colors"
          >
            {t('common.close', { defaultValue: '关闭' })}
          </button>
        </div>
      </div>
    </div>
  )
}
