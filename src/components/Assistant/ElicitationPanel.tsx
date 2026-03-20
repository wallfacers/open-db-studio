import React from 'react'
import { useTranslation } from 'react-i18next'
import type { ElicitationRequest, PermissionRequest } from '../../types'

// ── Props ─────────────────────────────────────────────────────────────────────

interface PermissionPanelProps {
  type: 'permission'
  request: PermissionRequest
  onRespond: (optionId: string, cancelled: boolean) => void
}

interface ElicitationPanelProps {
  type: 'elicitation'
  request: ElicitationRequest
  onSelect: (text: string) => void
  onCancel: () => void
}

type Props = PermissionPanelProps | ElicitationPanelProps

// ── Component ─────────────────────────────────────────────────────────────────

const ElicitationPanel: React.FC<Props> = (props) => {
  if (props.type === 'permission') return <PermissionPanel {...props} />
  return <ElicitationSelectPanel {...props} />
}

export default ElicitationPanel

// ── Permission Panel（request_permission 路径） ───────────────────────────────

const PermissionPanel: React.FC<PermissionPanelProps> = ({ request, onRespond }) => {
  const kindOrder = ['allow_once', 'allow_always', 'reject_once', 'reject_always', 'deny'] as const
  const sorted = [...request.options].sort(
    (a, b) => kindOrder.indexOf(a.kind as typeof kindOrder[number]) - kindOrder.indexOf(b.kind as typeof kindOrder[number])
  )

  return (
    <div className="mx-3 mb-3 rounded-lg border border-[#1e3a5f] bg-[#0d2137] p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-[13px]">🔐</span>
        <span className="text-[12px] font-semibold text-[#8ab0cc]">工具执行确认</span>
      </div>
      <p className="mb-3 text-[12px] text-[#c8daea] leading-relaxed">{request.message}</p>
      <div className="flex flex-wrap gap-2">
        {sorted.map((opt) => (
          <button
            key={opt.option_id}
            onClick={() => onRespond(opt.option_id, false)}
            className={`rounded px-3 py-1.5 text-[12px] font-medium transition-colors ${
              opt.kind === 'deny' || opt.kind === 'reject_once' || opt.kind === 'reject_always'
                ? 'border border-[#3a1a1a] bg-[#1a0a0a] text-[#e05c5c] hover:bg-[#2a1010]'
                : 'border border-[#1e4a7f] bg-[#0d2a4a] text-[#4a9eff] hover:bg-[#0d3060]'
            }`}
          >
            {opt.label}
          </button>
        ))}
        <button
          onClick={() => onRespond('', true)}
          className="rounded border border-[#2a3a4a] bg-transparent px-3 py-1.5 text-[12px] text-[#5b8ab0] transition-colors hover:border-[#3a5a7a] hover:text-[#8ab0cc]"
        >
          取消
        </button>
      </div>
    </div>
  )
}

// ── Elicitation Select Panel（文字检测路径） ──────────────────────────────────

const ElicitationSelectPanel: React.FC<ElicitationPanelProps> = ({ request, onSelect, onCancel }) => {
  const { t } = useTranslation()
  return (
    <div className="mx-3 mb-3 rounded-lg border border-[#1e3a5f] bg-[#0d2137] p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-[13px]">📋</span>
        <span className="text-[12px] font-semibold text-[#8ab0cc]">{request.message}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {request.options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onSelect(opt.value)}
            className="w-full rounded border border-[#1e3a5f] bg-[#0a1a2e] px-3 py-2 text-left text-[12px] text-[#c8daea] transition-colors hover:border-[#2a5a8f] hover:bg-[#0d2a4a]"
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className="mt-2 flex justify-end">
        <button
          onClick={onCancel}
          className="rounded border border-[#2a3a4a] bg-transparent px-3 py-1 text-[11px] text-[#5b8ab0] transition-colors hover:text-[#8ab0cc]"
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}
