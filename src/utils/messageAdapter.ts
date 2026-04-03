import type { ChatMessage, MessagePart, TextPart, ReasoningPart } from '../types';

/**
 * 将 ChatMessage 标准化为 MessagePart[]
 * - 如果消息已有 parts 字段，直接返回
 * - 否则从 content/thinkingContent 合成 parts（向后兼容旧消息）
 */
export function normalizeMessage(msg: ChatMessage): MessagePart[] {
  if (msg.parts && msg.parts.length > 0) {
    return msg.parts;
  }

  const parts: MessagePart[] = [];

  if (msg.thinkingContent) {
    parts.push({ type: 'reasoning', content: msg.thinkingContent } as ReasoningPart);
  }

  if (msg.content) {
    parts.push({ type: 'text', content: msg.content } as TextPart);
  }

  return parts;
}

/**
 * 将 MessagePart[] 扁平化为 { content, thinkingContent }
 * 用于向后兼容的序列化场景
 */
export function flattenParts(parts: MessagePart[]): { content: string; thinkingContent?: string } {
  let content = '';
  let thinkingContent = '';

  for (const part of parts) {
    switch (part.type) {
      case 'text':
        content += (content ? '\n\n' : '') + part.content;
        break;
      case 'reasoning':
        thinkingContent += (thinkingContent ? '\n\n' : '') + part.content;
        break;
      case 'tool-use':
        content += (content ? '\n\n' : '') + `[Tool: ${part.name}]`;
        break;
      case 'tool-result':
        content += (content ? '\n\n' : '') + part.output;
        break;
    }
  }

  return { content, thinkingContent: thinkingContent || undefined };
}

/**
 * 将消息中连续的 reasoning parts 合并为一个。
 * 非连续的（中间夹着 text/tool 等非 reasoning 内容）保持为独立思考块。
 * 用于渲染层减少重复的思考块，同时保留思考-文本交替的结构。
 */
export function mergeReasoningForDisplay(parts: MessagePart[]): MessagePart[] {
  const result: MessagePart[] = []
  let buffer: string[] = []

  const flush = () => {
    if (buffer.length === 0) return
    result.push({ type: 'reasoning', content: buffer.join('\n\n') })
    buffer = []
  }

  for (const part of parts) {
    if (part.type === 'reasoning' && part.content) {
      buffer.push(part.content)
    } else {
      flush()
      result.push(part)
    }
  }
  flush()

  // 没有连续 reasoning 需要合并，返回原数组保持引用稳定
  if (result.length === parts.length) return parts
  return result
}
