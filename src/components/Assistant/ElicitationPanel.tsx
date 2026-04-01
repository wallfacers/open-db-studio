import React from 'react'
import { useTranslation } from 'react-i18next'
import type { PermissionRequest } from '../../types'

interface Props {
  request: PermissionRequest
  onRespond: (optionId: string, cancelled: boolean) => void
}

const ElicitationPanel: React.FC<Props> = ({ request, onRespond }) => {
  const { t } = useTranslation()
  const kindOrder = ['allow_once', 'allow_always', 'reject_once', 'reject_always', 'deny'] as const
  const sorted = [...request.options].sort(
    (a, b) => kindOrder.indexOf(a.kind as typeof kindOrder[number]) - kindOrder.indexOf(b.kind as typeof kindOrder[number])
  )

  return (
    <div className="mx-3 mb-3 rounded-lg border border-[var(--border-strong)] bg-[var(--background-base)] p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-[13px]">🔐</span>
        <span className="text-[12px] font-semibold text-[var(--foreground-default)]">{t('assistant.elicitation.title')}</span>
      </div>
      <p className="mb-3 text-[12px] text-[var(--foreground-default)] leading-relaxed">{request.message}</p>
      <div className="flex flex-wrap gap-2">
        {sorted.map((opt) => (
          <button
            key={opt.option_id}
            onClick={() => onRespond(opt.option_id, false)}
            className={`rounded px-3 py-1.5 text-[12px] font-medium transition-colors ${
              opt.kind === 'deny' || opt.kind === 'reject_once' || opt.kind === 'reject_always'
                ? 'border border-[var(--error-subtle)] bg-[var(--error-subtle)] text-[var(--error)] hover:bg-[var(--danger-hover-bg)]'
                : 'border border-[var(--border-strong)] bg-[var(--primary-subtle)] text-[var(--info)] hover:bg-[var(--primary-subtle)]'
            }`}
          >
            {opt.label}
          </button>
        ))}
        <button
          onClick={() => onRespond('', true)}
          className="rounded border border-[var(--border-strong)] bg-transparent px-3 py-1.5 text-[12px] text-[var(--foreground-muted)] transition-colors hover:border-[var(--border-focus)] hover:text-[var(--foreground-default)]"
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}

export default ElicitationPanel
