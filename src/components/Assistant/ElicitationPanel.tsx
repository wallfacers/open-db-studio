import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock, Check, X, ChevronRight } from 'lucide-react'
import type { PermissionRequest, QuestionRequest, QuestionInfo } from '../../types'

// ── 权限确认 Dock ──────────────────────────────────────────────────────────

interface PermissionDockProps {
  request: PermissionRequest
  onRespond: (optionId: string, cancelled: boolean) => void
}

const PermissionDock: React.FC<PermissionDockProps> = ({ request, onRespond }) => {
  const { t } = useTranslation()
  const [focusedIndex, setFocusedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  const kindOrder = ['allow_once', 'allow_always', 'reject_once', 'reject_always', 'deny'] as const
  const sorted = [...request.options].sort(
    (a, b) => kindOrder.indexOf(a.kind as typeof kindOrder[number]) - kindOrder.indexOf(b.kind as typeof kindOrder[number])
  )
  // 加一个 cancel 选项
  const allOptions = [...sorted, { option_id: '__cancel__', label: t('common.cancel'), kind: 'cancel' as const }]

  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowLeft':
        e.preventDefault()
        setFocusedIndex((i) => (i - 1 + allOptions.length) % allOptions.length)
        break
      case 'ArrowDown':
      case 'ArrowRight':
        e.preventDefault()
        setFocusedIndex((i) => (i + 1) % allOptions.length)
        break
      case 'Enter':
        e.preventDefault()
        const opt = allOptions[focusedIndex]
        if (opt.option_id === '__cancel__') {
          onRespond('', true)
        } else {
          onRespond(opt.option_id, false)
        }
        break
      case 'Escape':
        e.preventDefault()
        onRespond('', true)
        break
    }
  }, [allOptions, focusedIndex, onRespond])

  return (
    <div
      ref={containerRef}
      className="border-t border-border-strong bg-background-panel p-3"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-center gap-1.5 mb-2">
        <Lock size={12} className="text-accent" />
        <span className="text-[12px] font-semibold text-foreground-default">{t('assistant.elicitation.title')}</span>
      </div>
      <p className="mb-2.5 text-[12px] text-foreground-default leading-relaxed">{request.message}</p>
      <div className="flex flex-wrap gap-1.5">
        {allOptions.map((opt, i) => {
          const isReject = opt.kind === 'deny' || opt.kind === 'reject_once' || opt.kind === 'reject_always'
          const isCancel = opt.kind === 'cancel'
          const isFocused = i === focusedIndex

          return (
            <button
              key={opt.option_id}
              onClick={() => isCancel ? onRespond('', true) : onRespond(opt.option_id, false)}
              onMouseEnter={() => setFocusedIndex(i)}
              className={`rounded px-3 py-1.5 text-[12px] font-medium transition-all outline-none ${
                isCancel
                  ? `border border-border-strong bg-transparent text-foreground-muted hover:text-foreground-default ${isFocused ? 'ring-1 ring-accent' : ''}`
                  : isReject
                    ? `border border-error-subtle bg-error-subtle text-error hover:bg-danger-hover-bg ${isFocused ? 'ring-1 ring-error' : ''}`
                    : `border border-border-strong bg-primary-subtle text-info hover:bg-primary-subtle ${isFocused ? 'ring-1 ring-accent' : ''}`
              }`}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
      <div className="mt-1.5 text-[10px] text-foreground-ghost">
        ← → {t('assistant.elicitation.navHint', { defaultValue: '选择' })} · Enter {t('assistant.elicitation.confirmHint', { defaultValue: '确认' })} · Esc {t('assistant.elicitation.cancelHint', { defaultValue: '取消' })}
      </div>
    </div>
  )
}

// ── 问答 Dock ──────────────────────────────────────────────────────────────

interface QuestionDockProps {
  request: QuestionRequest
  onAnswer: (questionId: string, answers: string[][], cancelled: boolean) => void
}

const QuestionDock: React.FC<QuestionDockProps> = ({ request, onAnswer }) => {
  const { t } = useTranslation()
  const [currentStep, setCurrentStep] = useState(0)
  const [answers, setAnswers] = useState<string[][]>(() =>
    request.questions.map(() => [])
  )
  const [customInput, setCustomInput] = useState('')
  const [focusedIndex, setFocusedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const question = request.questions[currentStep]
  if (!question) return null

  const isMultiple = question.multiple ?? false
  const allowCustom = question.custom !== false // 默认 true
  const isLastStep = currentStep === request.questions.length - 1

  const currentAnswer = answers[currentStep] ?? []

  const toggleOption = (label: string) => {
    setAnswers((prev) => {
      const copy = [...prev]
      const current = copy[currentStep] ?? []
      if (isMultiple) {
        copy[currentStep] = current.includes(label)
          ? current.filter((a) => a !== label)
          : [...current, label]
      } else {
        copy[currentStep] = [label]
      }
      return copy
    })
  }

  const handleSubmit = () => {
    // 如果有自定义输入且没有选中任何选项，使用自定义输入
    const finalAnswers = answers.map((a, i) => {
      if (a.length === 0 && i === currentStep && customInput.trim()) {
        return [customInput.trim()]
      }
      return a
    })
    if (isLastStep) {
      onAnswer(request.question_id, finalAnswers, false)
    } else {
      if (customInput.trim() && currentAnswer.length === 0) {
        setAnswers((prev) => {
          const copy = [...prev]
          copy[currentStep] = [customInput.trim()]
          return copy
        })
      }
      setCustomInput('')
      setFocusedIndex(0)
      setCurrentStep((s) => s + 1)
    }
  }

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const optCount = question.options.length + (allowCustom ? 1 : 0) // +1 for custom input
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault()
        setFocusedIndex((i) => (i - 1 + optCount) % optCount)
        break
      case 'ArrowDown':
        e.preventDefault()
        setFocusedIndex((i) => (i + 1) % optCount)
        break
      case 'Enter':
        e.preventDefault()
        if (focusedIndex < question.options.length) {
          if (!isMultiple) {
            // 单选直接提交
            const label = question.options[focusedIndex].label
            setAnswers((prev) => {
              const copy = [...prev]
              copy[currentStep] = [label]
              return copy
            })
            // 延迟提交让 state 更新
            setTimeout(handleSubmit, 0)
          } else {
            toggleOption(question.options[focusedIndex].label)
          }
        } else if (allowCustom && customInput.trim()) {
          handleSubmit()
        }
        break
      case 'Escape':
        e.preventDefault()
        onAnswer(request.question_id, [], true)
        break
    }
  }, [question, focusedIndex, isMultiple, allowCustom, customInput, currentStep]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={containerRef}
      className="border-t border-border-strong bg-background-panel p-3"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* 多步骤进度指示 */}
      {request.questions.length > 1 && (
        <div className="flex items-center gap-1 mb-2">
          {request.questions.map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i <= currentStep ? 'bg-accent' : 'bg-border-default'
              }`}
            />
          ))}
          <span className="text-[10px] text-foreground-ghost ml-1">{currentStep + 1}/{request.questions.length}</span>
        </div>
      )}

      {/* 问题标题和内容 */}
      {question.header && (
        <div className="text-[12px] font-semibold text-foreground-default mb-1">{question.header}</div>
      )}
      {question.question && (
        <div className="text-[12px] text-foreground-default leading-relaxed mb-2">{question.question}</div>
      )}

      {/* 选项列表 */}
      <div className="space-y-1 mb-2">
        {question.options.map((opt, i) => {
          const isSelected = currentAnswer.includes(opt.label)
          const isFocused = i === focusedIndex

          return (
            <button
              key={i}
              onClick={() => {
                toggleOption(opt.label)
                if (!isMultiple) setTimeout(handleSubmit, 0)
              }}
              onMouseEnter={() => setFocusedIndex(i)}
              className={`w-full text-left rounded px-2.5 py-1.5 text-[12px] transition-all outline-none flex items-center gap-2 ${
                isFocused ? 'bg-background-hover' : 'hover:bg-background-elevated'
              } ${isSelected ? 'border border-accent bg-accent/10' : 'border border-transparent'}`}
            >
              {/* 单选/多选指示器 */}
              <span className={`flex-shrink-0 w-3.5 h-3.5 rounded-${isMultiple ? 'sm' : 'full'} border flex items-center justify-center ${
                isSelected ? 'border-accent bg-accent' : 'border-border-strong'
              }`}>
                {isSelected && <Check size={9} className="text-background-base" />}
              </span>
              <span className="flex-1">
                <span className="text-foreground-default">{opt.label}</span>
                {opt.description && (
                  <span className="text-foreground-ghost ml-1.5">— {opt.description}</span>
                )}
              </span>
            </button>
          )
        })}
      </div>

      {/* 自定义输入 */}
      {allowCustom && (
        <div className="mb-2">
          <input
            ref={inputRef}
            type="text"
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onFocus={() => setFocusedIndex(question.options.length)}
            placeholder={t('assistant.question.customPlaceholder', { defaultValue: '输入自定义回答...' })}
            className="w-full bg-background-base border border-border-default rounded px-2.5 py-1.5 text-[12px] text-foreground-default placeholder:text-foreground-ghost outline-none focus:border-accent transition-colors"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && customInput.trim()) {
                e.preventDefault()
                e.stopPropagation()
                handleSubmit()
              }
            }}
          />
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex items-center justify-between">
        <div className="text-[10px] text-foreground-ghost">
          ↑↓ {t('assistant.elicitation.navHint', { defaultValue: '选择' })} · Enter {t('assistant.elicitation.confirmHint', { defaultValue: '确认' })} · Esc {t('assistant.elicitation.cancelHint', { defaultValue: '取消' })}
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={() => onAnswer(request.question_id, [], true)}
            className="rounded px-2.5 py-1 text-[11px] text-foreground-muted border border-border-strong hover:text-foreground-default transition-colors"
          >
            {t('common.cancel')}
          </button>
          {isMultiple && (
            <button
              onClick={handleSubmit}
              disabled={currentAnswer.length === 0 && !customInput.trim()}
              className="rounded px-2.5 py-1 text-[11px] font-medium bg-accent text-background-base hover:bg-accent-hover disabled:opacity-40 transition-colors flex items-center gap-1"
            >
              {isLastStep ? t('assistant.question.submit', { defaultValue: '提交' }) : t('assistant.question.next', { defaultValue: '下一步' })}
              {!isLastStep && <ChevronRight size={10} />}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 组合导出 ────────────────────────────────────────────────────────────────

export { PermissionDock, QuestionDock }
export default PermissionDock
