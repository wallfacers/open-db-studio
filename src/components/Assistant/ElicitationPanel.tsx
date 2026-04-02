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
    <div className="mx-3 mb-3 rounded-lg border border-border-strong bg-background-base p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-[13px]">🔐</span>
        <span className="text-[12px] font-semibold text-foreground-default">{t('assistant.elicitation.title')}</span>
      </div>
      <p className="mb-3 text-[12px] text-foreground-default leading-relaxed">{request.message}</p>
      <div className="flex flex-wrap gap-2">
        {sorted.map((opt) => (
          <button
            key={opt.option_id}
            onClick={() => onRespond(opt.option_id, false)}
            className={`rounded px-3 py-1.5 text-[12px] font-medium transition-colors ${
              opt.kind === 'deny' || opt.kind === 'reject_once' || opt.kind === 'reject_always'
                ? 'border border-error-subtle bg-error-subtle text-error hover:bg-danger-hover-bg'
                : 'border border-border-strong bg-primary-subtle text-info hover:bg-primary-subtle'
            }`}
          >
            {opt.label}
          </button>
        ))}
        <button
          onClick={() => onRespond('', true)}
          className="rounded border border-border-strong bg-transparent px-3 py-1.5 text-[12px] text-foreground-muted transition-colors hover:border-border-focus hover:text-foreground-default"
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}

export default ElicitationPanel
