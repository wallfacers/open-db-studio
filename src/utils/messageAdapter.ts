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
 * 将消息中所有 reasoning parts 合并为一个，放在第一个 reasoning 的位置。
 * 其余非 reasoning parts 保持原序。用于渲染层减少重复的思考块。
 */
export function mergeReasoningForDisplay(parts: MessagePart[]): MessagePart[] {
  const reasoningContents: string[] = []
  for (const part of parts) {
    if (part.type === 'reasoning' && part.content) {
      reasoningContents.push(part.content)
    }
  }
  if (reasoningContents.length <= 1) return parts

  const result: MessagePart[] = []
  let inserted = false
  for (const part of parts) {
    if (part.type === 'reasoning') {
      if (!inserted) {
        result.push({ type: 'reasoning', content: reasoningContents.join('\n\n') })
        inserted = true
      }
    } else {
      result.push(part)
    }
  }
  return result
}
