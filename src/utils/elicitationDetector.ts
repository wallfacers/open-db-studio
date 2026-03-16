import type { ElicitationRequest, ElicitationOption } from '../types'

/**
 * 检测 AI 消息内容中是否包含结构化的选项列表，若包含则返回 ElicitationRequest。
 *
 * 触发条件（两者均须满足）：
 * 1. 选项格式：数字列表（`1. xxx` 或 `1) xxx`）或字母选项（`A. xxx` 或 `A) xxx`），至少 2 项
 * 2. 问句特征：消息末尾含 `?`/`？`，或含关键词 请选择/请问/哪个/哪种/您需要/你需要
 */
export function detectElicitation(
  content: string,
  sessionId: string,
): ElicitationRequest | null {
  // ── 1. 尝试解析选项 ──────────────────────────────────────────────────────
  const options = parseOptions(content)
  if (options.length < 2) return null

  // ── 2. 问句特征检测 ───────────────────────────────────────────────────────
  const trimmed = content.trim()
  const hasQuestionMark = /[?？]/.test(trimmed.slice(-50))
  const hasKeyword = /请选择|请问|哪个|哪种|您需要|你需要/.test(content)
  if (!hasQuestionMark && !hasKeyword) return null

  // ── 3. 提取提示语（取选项列表之前的最后一段非空文本） ───────────────────
  const message = extractMessage(content) || '请选择以下选项之一：'

  return {
    id: crypto.randomUUID(),
    sessionId,
    source: 'text',
    type: 'select',
    message,
    options,
  }
}

// ── 内部工具函数 ─────────────────────────────────────────────────────────────

/** 从内容中解析选项列表 */
function parseOptions(content: string): ElicitationOption[] {
  const lines = content.split('\n')

  // 数字列表：`1. xxx` 或 `1) xxx`
  const numDotPattern = /^\s*(\d+)[.)]\s+(.+)$/
  const numMatches = lines
    .map((l) => numDotPattern.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)

  if (numMatches.length >= 2) {
    return numMatches.map((m) => ({
      value: m[0].trim(),   // 完整行文本作为发送内容（保留序号）
      label: m[2].trim(),   // 选项文本（不含序号）
    }))
  }

  // 字母选项：`A. xxx` 或 `A) xxx`（仅大写字母，防止误匹配正文句子）
  const alphaPattern = /^\s*([A-Z])[.)]\s+(.+)$/
  const alphaMatches = lines
    .map((l) => alphaPattern.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)

  if (alphaMatches.length >= 2) {
    return alphaMatches.map((m) => ({
      value: m[0].trim(),
      label: m[2].trim(),
    }))
  }

  return []
}

/** 提取选项列表之前的最后一段非空文本作为提示语 */
function extractMessage(content: string): string {
  const lines = content.split('\n')
  // 找到第一个选项行的位置
  const optionLineIndex = lines.findIndex((l) =>
    /^\s*[\dA-Z][.)]\s+/.test(l)
  )
  if (optionLineIndex <= 0) return ''

  // 取选项行之前的文本，逆序找最后一段非空行
  const beforeOptions = lines.slice(0, optionLineIndex)
  for (let i = beforeOptions.length - 1; i >= 0; i--) {
    const line = beforeOptions[i].trim()
    if (line) return line
  }
  return ''
}
