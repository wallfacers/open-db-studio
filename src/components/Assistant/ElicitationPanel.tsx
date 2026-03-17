import React, { useState } from 'react'
import type { ElicitationRequest, PermissionRequest, AcpElicitationRequest } from '../../types'

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

interface AcpElicitationPanelProps {
  type: 'acp-elicitation'
  request: AcpElicitationRequest
  onRespond: (action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) => void
}

type Props = PermissionPanelProps | ElicitationPanelProps | AcpElicitationPanelProps

// ── Component ─────────────────────────────────────────────────────────────────

const ElicitationPanel: React.FC<Props> = (props) => {
  if (props.type === 'permission') return <PermissionPanel {...props} />
  if (props.type === 'acp-elicitation') return <AcpElicitationFormPanel {...props} />
  return <ElicitationSelectPanel {...props} />
}

export default ElicitationPanel

// ── Permission Panel（ACP request_permission 路径） ───────────────────────────

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
          取消
        </button>
      </div>
    </div>
  )
}

// ── ACP Elicitation Form Panel（ext_method 桥接路径） ─────────────────────────

/**
 * 渲染 ACP session/elicitation 请求的 form 面板。
 * 支持三种 schema 类型：enum（按钮选项）、boolean（是/否）、string/free（文本输入）。
 */
const AcpElicitationFormPanel: React.FC<AcpElicitationPanelProps> = ({ request, onRespond }) => {
  const { message, schema } = request
  const properties = (schema as Record<string, unknown>).properties as Record<string, unknown> | undefined
  const required = ((schema as Record<string, unknown>).required as string[] | undefined) ?? []

  // 解析第一个字段（ACP 规范建议 schema 为平坦对象）
  const fields = properties ? Object.entries(properties) : []
  const [formValues, setFormValues] = useState<Record<string, unknown>>({})

  const handleSubmit = () => {
    onRespond('accept', formValues)
  }

  return (
    <div className="mx-3 mb-3 rounded-lg border border-[#1e3a5f] bg-[#0d2137] p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-[13px]">💬</span>
        <span className="text-[12px] font-semibold text-[#8ab0cc]">AI 需要更多信息</span>
      </div>
      <p className="mb-3 text-[12px] text-[#c8daea] leading-relaxed">{message}</p>

      {fields.length === 0 ? (
        /* 无 schema 字段：仅显示确认/取消 */
        <div className="flex gap-2">
          <button
            onClick={() => onRespond('accept', {})}
            className="rounded border border-[#1e4a7f] bg-[#0d2a4a] px-3 py-1.5 text-[12px] text-[#4a9eff] hover:bg-[#0d3060] transition-colors"
          >
            确认
          </button>
          <button
            onClick={() => onRespond('cancel')}
            className="rounded border border-[#2a3a4a] bg-transparent px-3 py-1.5 text-[12px] text-[#5b8ab0] hover:text-[#8ab0cc] transition-colors"
          >
            取消
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {fields.map(([fieldName, fieldSchema]) => (
            <FieldRenderer
              key={fieldName}
              name={fieldName}
              schema={fieldSchema as Record<string, unknown>}
              required={required.includes(fieldName)}
              value={formValues[fieldName]}
              onChange={(v) => setFormValues((prev) => ({ ...prev, [fieldName]: v }))}
            />
          ))}
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleSubmit}
              className="rounded border border-[#1e4a7f] bg-[#0d2a4a] px-3 py-1.5 text-[12px] text-[#4a9eff] hover:bg-[#0d3060] transition-colors"
            >
              提交
            </button>
            <button
              onClick={() => onRespond('decline')}
              className="rounded border border-[#3a1a1a] bg-[#1a0a0a] px-3 py-1.5 text-[12px] text-[#e05c5c] hover:bg-[#2a1010] transition-colors"
            >
              拒绝
            </button>
            <button
              onClick={() => onRespond('cancel')}
              className="rounded border border-[#2a3a4a] bg-transparent px-3 py-1.5 text-[12px] text-[#5b8ab0] hover:text-[#8ab0cc] transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 字段渲染器 ────────────────────────────────────────────────────────────────

interface FieldRendererProps {
  name: string
  schema: Record<string, unknown>
  required: boolean
  value: unknown
  onChange: (v: unknown) => void
}

const FieldRenderer: React.FC<FieldRendererProps> = ({ name, schema, required, value, onChange }) => {
  const label = (schema.title as string | undefined) ?? name
  const description = schema.description as string | undefined
  const type = schema.type as string | undefined

  // enum / oneOf → 按钮选项
  const enumValues = schema.enum as unknown[] | undefined
  const oneOfValues = schema.oneOf as Array<{ const: unknown; title?: string }> | undefined
  const anyOfValues = schema.anyOf as Array<{ const: unknown; title?: string }> | undefined
  const options = enumValues
    ? enumValues.map((v) => ({ value: v, label: String(v) }))
    : (oneOfValues ?? anyOfValues)?.map((o) => ({ value: o.const, label: o.title ?? String(o.const) }))

  if (options) {
    return (
      <div>
        <div className="mb-1 text-[11px] text-[#7a9bb8]">
          {label}{required && <span className="text-red-400 ml-0.5">*</span>}
        </div>
        {description && <div className="mb-1.5 text-[11px] text-[#4a6a8a]">{description}</div>}
        <div className="flex flex-wrap gap-1.5">
          {options.map((opt) => (
            <button
              key={String(opt.value)}
              onClick={() => onChange(opt.value)}
              className={`rounded px-2.5 py-1 text-[12px] transition-colors ${
                value === opt.value
                  ? 'border border-[#00c9a7] bg-[#003a2e] text-[#00c9a7]'
                  : 'border border-[#1e3a5f] bg-[#0a1a2e] text-[#c8daea] hover:border-[#2a5a8f]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    )
  }

  // boolean → 是/否
  if (type === 'boolean') {
    return (
      <div>
        <div className="mb-1 text-[11px] text-[#7a9bb8]">
          {label}{required && <span className="text-red-400 ml-0.5">*</span>}
        </div>
        {description && <div className="mb-1.5 text-[11px] text-[#4a6a8a]">{description}</div>}
        <div className="flex gap-2">
          {[{ v: true, l: '是' }, { v: false, l: '否' }].map(({ v, l }) => (
            <button
              key={String(v)}
              onClick={() => onChange(v)}
              className={`rounded px-3 py-1 text-[12px] transition-colors ${
                value === v
                  ? 'border border-[#00c9a7] bg-[#003a2e] text-[#00c9a7]'
                  : 'border border-[#1e3a5f] bg-[#0a1a2e] text-[#c8daea] hover:border-[#2a5a8f]'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
    )
  }

  // string / number / integer → 文本输入
  return (
    <div>
      <div className="mb-1 text-[11px] text-[#7a9bb8]">
        {label}{required && <span className="text-red-400 ml-0.5">*</span>}
      </div>
      {description && <div className="mb-1.5 text-[11px] text-[#4a6a8a]">{description}</div>}
      <input
        type={type === 'number' || type === 'integer' ? 'number' : 'text'}
        value={value as string ?? ''}
        onChange={(e) => onChange(type === 'number' || type === 'integer' ? Number(e.target.value) : e.target.value)}
        className="w-full rounded border border-[#1e3a5f] bg-[#0a1a2e] px-2.5 py-1.5 text-[12px] text-[#c8daea] outline-none focus:border-[#00c9a7] transition-colors"
        placeholder={`请输入${label}`}
      />
    </div>
  )
}
