import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { useAiStore } from './aiStore';
import type { MessagePart } from '../types';

const mockInvoke = vi.mocked(invoke);

const SESSION_ID = 'ses_test_01';

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue(undefined);
  useAiStore.setState({
    sessions: [],
    currentSessionId: SESSION_ID,
    chatHistory: [{ role: 'user', content: '请解释一下 SQL' }],
    chatStates: {
      [SESSION_ID]: {
        isChatting: true,
        streamingContent: '',
        streamingThinkingContent: '',
        activeToolName: null,
        sessionStatus: null,
        pendingPermission: null,
        pendingQuestion: null,
        pendingConfigId: null,
        lastUserMessageId: null,
        canRedo: false,
        isCompacting: false,
        toolSteps: [],
        streamingParts: [],
      },
    },
  });
});

describe('cancelChat — 推理阶段保留思考内容（bugfix）', () => {
  it('仅有思考内容时取消，应保存思考内容到 chatHistory（而非丢弃）', async () => {
    const thinking = '正在分析 SQL 语法...';
    const reasoningPart: MessagePart = { type: 'reasoning', content: thinking };
    useAiStore.setState((s) => ({
      chatStates: {
        ...s.chatStates,
        [SESSION_ID]: {
          ...s.chatStates[SESSION_ID],
          streamingThinkingContent: thinking,
          streamingParts: [reasoningPart],
        },
      },
    }));

    await useAiStore.getState().cancelChat(SESSION_ID);

    const { chatHistory, chatStates } = useAiStore.getState();
    const assistantMsg = chatHistory.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.thinkingContent).toBe(thinking);
    expect(assistantMsg?.content).toBe('');
    expect(assistantMsg?.parts).toEqual([reasoningPart]);
    // chatStates 已重置
    expect(chatStates[SESSION_ID].isChatting).toBe(false);
    expect(chatStates[SESSION_ID].streamingThinkingContent).toBe('');
  });

  it('同时有正文与思考内容时取消，应同时保存正文、思考、parts', async () => {
    const thinking = '推理过程';
    const content = '部分回答';
    const parts: MessagePart[] = [
      { type: 'reasoning', content: thinking },
      { type: 'text', content },
    ];
    useAiStore.setState((s) => ({
      chatStates: {
        ...s.chatStates,
        [SESSION_ID]: {
          ...s.chatStates[SESSION_ID],
          streamingContent: content,
          streamingThinkingContent: thinking,
          streamingParts: parts,
        },
      },
    }));

    await useAiStore.getState().cancelChat(SESSION_ID);

    const assistantMsg = useAiStore
      .getState()
      .chatHistory.find((m) => m.role === 'assistant');
    expect(assistantMsg?.content).toBe(content);
    expect(assistantMsg?.thinkingContent).toBe(thinking);
    expect(assistantMsg?.parts).toEqual(parts);
  });

  it('合并 streamingParts 中连续的同类型片段', async () => {
    const parts: MessagePart[] = [
      { type: 'reasoning', content: '第一段思考。' },
      { type: 'reasoning', content: '继续思考。' },
      { type: 'text', content: '回答片段1' },
      { type: 'text', content: '回答片段2' },
    ];
    useAiStore.setState((s) => ({
      chatStates: {
        ...s.chatStates,
        [SESSION_ID]: {
          ...s.chatStates[SESSION_ID],
          streamingContent: '回答片段1回答片段2',
          streamingParts: parts,
        },
      },
    }));

    await useAiStore.getState().cancelChat(SESSION_ID);

    const assistantMsg = useAiStore
      .getState()
      .chatHistory.find((m) => m.role === 'assistant');
    expect(assistantMsg?.parts).toEqual([
      { type: 'reasoning', content: '第一段思考。继续思考。' },
      { type: 'text', content: '回答片段1回答片段2' },
    ]);
  });

  it('没有任何内容时取消，不追加 assistant 消息，仅重置状态', async () => {
    await useAiStore.getState().cancelChat(SESSION_ID);

    const { chatHistory, chatStates } = useAiStore.getState();
    expect(chatHistory.find((m) => m.role === 'assistant')).toBeUndefined();
    expect(chatStates[SESSION_ID].isChatting).toBe(false);
  });
});
