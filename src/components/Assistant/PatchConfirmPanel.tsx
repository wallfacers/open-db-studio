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
      <span className="text-[#7a9bb8]">{op.path}</span>
      {op.value !== undefined && (
        <span className="text-[#c8daea]">
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
    <div className="border-t border-[#1e2d42] bg-[#0d1117]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#1e2d42]">
        <span className="text-xs font-medium text-[#c8daea]">
          AI Patch: <strong>{pending.objectType}</strong>
        </span>
        <Tooltip content={t('common.cancel')} className="contents">
          <button
            onClick={reject}
            className="text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
          >
            <X size={14} />
          </button>
        </Tooltip>
      </div>

      {/* Reason */}
      {pending.reason && (
        <div className="px-3 py-1.5 text-xs text-[#7a9bb8] bg-[#0d1117] border-b border-[#1e2d42]">
          {pending.reason}
        </div>
      )}

      {/* Patch operations */}
      <div className="overflow-x-auto max-h-48 overflow-y-auto">
        {pending.ops.map((op, i) => <OpLine key={i} op={op} />)}
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-[#1e2d42]">
        <button
          onClick={reject}
          className="text-xs px-3 py-1 rounded border border-[#2a3f5a] text-[#7a9bb8] hover:text-[#c8daea] hover:border-[#7a9bb8] transition-colors"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={confirm}
          className="text-xs px-3 py-1 rounded bg-[#00c9a7] text-white hover:bg-[#00a98f] transition-colors flex items-center gap-1"
        >
          <Check size={12} />
          {t('assistant.diffPanel.apply')}
        </button>
      </div>
    </div>
  )
}
