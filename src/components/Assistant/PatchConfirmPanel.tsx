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
    add: 'text-[#4ade80]',
    remove: 'text-[#f87171]',
    replace: 'text-[#60a5fa]',
    move: 'text-[#c084fc]',
    copy: 'text-[#94a3b8]',
    test: 'text-[#fbbf24]',
  }
  const bgMap: Record<string, string> = {
    add: 'bg-[#0e2a1a]',
    remove: 'bg-[#2a0e0e]',
    replace: 'bg-[#0e1a2a]',
    test: 'bg-[#2a2a0e]',
  }
  const colorClass = colorMap[op.op] ?? 'text-[#94a3b8]'
  const bgClass = bgMap[op.op] ?? ''

  return (
    <div className={`flex items-start gap-2 px-3 py-0.5 font-mono text-xs ${bgClass}`}>
      <span className={`select-none w-3 flex-shrink-0 font-bold ${colorClass}`}>{label}</span>
      <span className="text-[var(--foreground-muted)]">{op.path}</span>
      {op.value !== undefined && (
        <span className="text-[var(--foreground-default)]">
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
    <div className="border-t border-[var(--border-default)] bg-[var(--background-base)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-default)]">
        <span className="text-xs font-medium text-[var(--foreground-default)]">
          AI Patch: <strong>{pending.objectType}</strong>
        </span>
        <Tooltip content={t('common.cancel')} className="contents">
          <button
            onClick={reject}
            className="text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] transition-colors"
          >
            <X size={14} />
          </button>
        </Tooltip>
      </div>

      {/* Reason */}
      {pending.reason && (
        <div className="px-3 py-1.5 text-xs text-[var(--foreground-muted)] bg-[var(--background-base)] border-b border-[var(--border-default)]">
          {pending.reason}
        </div>
      )}

      {/* Patch operations */}
      <div className="overflow-x-auto max-h-48 overflow-y-auto">
        {pending.ops.map((op, i) => <OpLine key={i} op={op} />)}
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-[var(--border-default)]">
        <button
          onClick={reject}
          className="text-xs px-3 py-1 rounded border border-[var(--border-strong)] text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] hover:border-[var(--foreground-muted)] transition-colors"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={confirm}
          className="text-xs px-3 py-1 rounded bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors flex items-center gap-1"
        >
          <Check size={12} />
          {t('assistant.diffPanel.apply')}
        </button>
      </div>
    </div>
  )
}
