import React, { useEffect } from 'react'
import { Check, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { usePatchConfirmStore } from '../../store/patchConfirmStore'
import { Tooltip } from '../common/Tooltip'
import type { JsonPatchOp } from '../../mcp/ui/types'

const PATCH_TIMEOUT_MS = 60_000 // auto-reject after 60s

function OpLine({ op }: { op: JsonPatchOp }) {
  const label = { add: '+', remove: '-', replace: '~', move: '>', copy: '=', test: '?' }[op.op] ?? '?'
  const colorMap: Record<string, string> = {
    add: 'text-success',
    remove: 'text-error',
    replace: 'text-diff-modify',
    move: 'text-data-purple',
    copy: 'text-foreground-muted',
    test: 'text-warning',
  }
  const bgMap: Record<string, string> = {
    add: 'bg-diff-add-bg',
    remove: 'bg-diff-remove-bg',
    replace: 'bg-diff-modify-bg',
    test: 'bg-warning-subtle',
  }
  const colorClass = colorMap[op.op] ?? 'text-foreground-muted'
  const bgClass = bgMap[op.op] ?? ''

  return (
    <div className={`flex items-start gap-2 px-3 py-0.5 font-mono text-xs ${bgClass}`}>
      <span className={`select-none w-3 flex-shrink-0 font-bold ${colorClass}`}>{label}</span>
      <span className="text-foreground-muted">{op.path}</span>
      {op.value !== undefined && (
        <span className="text-foreground-default">
          {typeof op.value === 'object' ? JSON.stringify(op.value) : String(op.value)}
        </span>
      )}
    </div>
  )
}

export const PatchConfirmPanel: React.FC = () => {
  const { t } = useTranslation()
  const { pending, confirm, reject } = usePatchConfirmStore()

  // Auto-reject expired patches
  useEffect(() => {
    if (!pending) return
    const remaining = PATCH_TIMEOUT_MS - (Date.now() - pending.createdAt)
    if (remaining <= 0) { reject(); return }
    const timer = setTimeout(reject, remaining)
    return () => clearTimeout(timer)
  }, [pending, reject])

  if (!pending) return null

  return (
    <div className="border border-border-strong bg-background-base rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-default">
        <span className="text-xs font-medium text-foreground-default">
          AI Patch: <strong>{pending.objectType}</strong>
        </span>
        <Tooltip content={t('common.cancel')} className="contents">
          <button
            onClick={reject}
            className="text-foreground-muted hover:text-foreground-default transition-colors"
          >
            <X size={14} />
          </button>
        </Tooltip>
      </div>

      {/* Reason */}
      {pending.reason && (
        <div className="px-3 py-1.5 text-xs text-foreground-muted bg-background-base border-b border-border-default">
          {pending.reason}
        </div>
      )}

      {/* Patch operations */}
      <div className="overflow-x-auto max-h-48 overflow-y-auto">
        {pending.ops.map((op, i) => <OpLine key={i} op={op} />)}
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-border-default">
        <button
          onClick={reject}
          className="text-xs px-3 py-1 rounded border border-border-strong text-foreground-muted hover:text-foreground-default hover:border-foreground-muted transition-colors"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={confirm}
          className="text-xs px-3 py-1 rounded bg-accent text-foreground hover:bg-accent-hover transition-colors flex items-center gap-1"
        >
          <Check size={12} />
          {t('assistant.diffPanel.apply')}
        </button>
      </div>
    </div>
  )
}
