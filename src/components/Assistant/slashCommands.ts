import type { LucideIcon } from 'lucide-react';

export interface ChatCommandState {
  hasHistory: boolean;       // chatHistory.length > 0
  isChatting: boolean;       // 当前 session 正在回复
  canUndo: boolean;          // lastUserMessageId !== null
  canRedo: boolean;          // 执行过 undo 且未发新消息
  isCompacting: boolean;     // compact 执行中
  messageCount: number;      // chatHistory.length
}

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export interface CommandContext {
  sessionId: string;
  modelId: string | null;
  providerId: string | null;
  undoMessage: (sessionId: string) => Promise<void>;
  redoMessage: (sessionId: string) => Promise<void>;
  compactSession: (sessionId: string, modelId: string, providerId: string) => Promise<void>;
  newSession: () => Promise<void>;
  clearHistory: (sessionId: string) => Promise<void>;
  showToast: (msg: string, level?: ToastLevel) => void;
}

export interface SlashCommand {
  name: string;
  label: string;
  description: string;
  icon: LucideIcon;
  isAvailable: (state: ChatCommandState) => boolean;
  disabledReason?: (state: ChatCommandState) => string;
  execute: (ctx: CommandContext) => Promise<void>;
}
