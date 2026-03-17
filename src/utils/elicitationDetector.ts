import type { ElicitationRequest, ElicitationOption } from '../types'

/**
 * 检测 AI 消息内容中是否包含结构化的选项列表，若包含则返回 ElicitationRequest。
 *
 * 触发条件（两者均须满足）：
 * 1. 选项格式：数字列表（`1. xxx` 或 `1) xxx`）、字母选项（`A. xxx`）或短横线列表（`- xxx`），至少 2 项
 * 2. 问句特征：消息末尾含 `?`/`？`，或含问句关键词
 */
export function detectElicitation(
  content: string,
  sessionId: string,
): ElicitationRequest | null {
  // ── 1. 尝试解析选项 ──────────────────────────────────────────────────────
  const options = parseOptions(content)
  if (options.length < 2) return null

  // ── 2. 问句特征检测 ───────────────────────────────────────────────────────
  if (!hasQuestionFeature(content)) return null

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

/**
 * 判断流式内容是否已到达"完整选项块末尾"，用于 mid-stream 检测的触发时机。
 * 当最后一行非空内容是一个选项行时返回 true。
 */
export function isLikelyComplete(content: string): boolean {
  const lines = content.split('\n')
  const lastNonEmpty = [...lines].reverse().find((l) => l.trim())
  if (!lastNonEmpty) return false
  return isOptionLine(lastNonEmpty)
}

// ── 内部工具函数 ─────────────────────────────────────────────────────────────

const OPTION_PATTERNS = [
  /^\s*(\d+)[.)]\s+(.+)$/,              // 1. xxx 或 1) xxx
  /^\s*([A-Z])[.)]\s+(.+)$/,            // A. xxx 或 A) xxx（仅大写）
  /^\s*[-*]\s+(.+)$/,                   // - xxx 或 * xxx（短横线/星号列表）
] as const

function isOptionLine(line: string): boolean {
  return OPTION_PATTERNS.some((p) => p.test(line))
}

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
      value: m[0].trim(),
      label: m[2].trim(),
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

  // 短横线列表：`- xxx` 或 `* xxx`（需至少 2 项且在同一连续块中）
  const dashPattern = /^\s*[-*]\s+(.+)$/
  const dashMatches = lines
    .map((l) => dashPattern.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)

  if (dashMatches.length >= 2) {
    return dashMatches.map((m) => ({
      value: m[0].trim(),
      label: m[1].trim(),
    }))
  }

  return []
}

/** 检测问句特征 */
function hasQuestionFeature(content: string): boolean {
  // 末尾 80 字符内含问号
  if (/[?？]/.test(content.trim().slice(-80))) return true

  // 关键词匹配（中英文）
  const keywords =
    /请选择|请问|哪个|哪种|您需要|你需要|告诉我|选一个|您希望|你希望|您想要|你想要|是否需要|需要什么|什么方式|哪个方向|哪种方式|想要哪|how would you|which option|please choose|please select|what would you/i
  return keywords.test(content)
}

/** 提取选项列表之前的最后一段非空文本作为提示语 */
function extractMessage(content: string): string {
  const lines = content.split('\n')
  const optionLineIndex = lines.findIndex((l) => isOptionLine(l))
  if (optionLineIndex <= 0) return ''

  const beforeOptions = lines.slice(0, optionLineIndex)
  for (let i = beforeOptions.length - 1; i >= 0; i--) {
    const line = beforeOptions[i].trim()
    if (line) return line
  }
  return ''
}
