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
