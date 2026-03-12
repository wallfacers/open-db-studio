import { invoke } from '@tauri-apps/api/core';
import type { AgentMessage, AgentToolCall, ToolDefinition, ToolContext } from '../types';
import { executeTool } from './toolCatalog';

const MAX_TOOL_ITERATIONS = 10;

export interface AgentStreamCallbacks {
  onThinkingChunk: (delta: string) => void;
  onContentChunk: (delta: string) => void;
  onToolCall: (name: string) => void;
  onDone: () => void;
  onError: (msg: string) => void;
}

/**
 * Execute one LLM round (ai_chat_stream_with_tools or ai_chat_continue).
 * Returns { toolCalls: [...] } if LLM requests tool calls, or { toolCalls: [] } for text response.
 */
async function invokeAgentRound(
  command: 'ai_chat_stream_with_tools' | 'ai_chat_continue',
  messages: AgentMessage[],
  tools: ToolDefinition[],
  callbacks: AgentStreamCallbacks
): Promise<{ toolCalls: Array<{ call_id: string; name: string; arguments: string }> }> {
  const { Channel } = await import('@tauri-apps/api/core');
  const channel = new Channel<{
    type: 'ThinkingChunk' | 'ContentChunk' | 'ToolCallRequest' | 'Done' | 'Error';
    data?: { delta?: string; message?: string; call_id?: string; name?: string; arguments?: string };
  }>();

  const pendingToolCalls: Array<{ call_id: string; name: string; arguments: string }> = [];
  let done = false;

  return new Promise((resolve, reject) => {
    channel.onmessage = (event) => {
      if (event.type === 'ThinkingChunk' && event.data?.delta) {
        callbacks.onThinkingChunk(event.data.delta);
      } else if (event.type === 'ContentChunk' && event.data?.delta) {
        callbacks.onContentChunk(event.data.delta);
      } else if (event.type === 'ToolCallRequest') {
        pendingToolCalls.push({
          call_id: event.data?.call_id ?? '',
          name: event.data?.name ?? '',
          arguments: event.data?.arguments ?? '{}',
        });
      } else if (event.type === 'Done') {
        if (!done) {
          done = true;
          resolve({ toolCalls: pendingToolCalls });
        }
      } else if (event.type === 'Error') {
        if (!done) {
          done = true;
          callbacks.onError(event.data?.message ?? 'Unknown error');
          resolve({ toolCalls: [] });
        }
      }
    };

    invoke(command, { messages, tools, channel })
      .catch((e) => {
        if (!done) {
          done = true;
          reject(e);
        }
      });
  });
}

/**
 * Full Agent Loop:
 * 1. Call ai_chat_stream_with_tools
 * 2. If tool calls → execute tools → append messages → call ai_chat_continue
 * 3. Repeat until LLM returns text or max iterations reached
 *
 * Returns the full message history after the loop completes.
 */
export async function runAgentLoop(
  userMessage: string,
  history: AgentMessage[],
  tools: ToolDefinition[],
  context: ToolContext,
  callbacks: AgentStreamCallbacks
): Promise<AgentMessage[]> {
  const messages: AgentMessage[] = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  let command: 'ai_chat_stream_with_tools' | 'ai_chat_continue' = 'ai_chat_stream_with_tools';
  let assistantContent = '';
  let assistantThinking = '';

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    assistantContent = '';
    assistantThinking = '';

    const wrappedCallbacks: AgentStreamCallbacks = {
      ...callbacks,
      onThinkingChunk: (delta) => {
        assistantThinking += delta;
        callbacks.onThinkingChunk(delta);
      },
      onContentChunk: (delta) => {
        assistantContent += delta;
        callbacks.onContentChunk(delta);
      },
    };

    const { toolCalls } = await invokeAgentRound(command, messages, tools, wrappedCallbacks);

    if (toolCalls.length === 0) {
      // LLM returned text — loop ends
      break;
    }

    // Build assistant message with tool_calls
    const assistantMsg: AgentMessage = {
      role: 'assistant',
      content: assistantContent || undefined,
      tool_calls: toolCalls.map(tc => ({
        id: tc.call_id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
    messages.push(assistantMsg);

    // Execute each tool and append result messages
    for (const tc of toolCalls) {
      callbacks.onToolCall(tc.name);
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = JSON.parse(tc.arguments); } catch { /* invalid JSON → empty args */ }
      const result = await executeTool(tc.name, parsedArgs, context);
      messages.push({
        role: 'tool',
        tool_call_id: tc.call_id,
        name: tc.name,
        content: result,
      });
    }

    command = 'ai_chat_continue';
  }

  callbacks.onDone();
  return messages;
}
