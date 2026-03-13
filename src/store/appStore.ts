// src/store/appStore.ts
import { create } from 'zustand';

export interface OperationContext {
  type: 'sql_execute' | 'import' | 'export' | 'ai_request';
  connectionId: number;
  database?: string;
  schema?: string;
  sql?: string;
  taskId?: string;
  aiRequestType?: 'generate' | 'explain' | 'optimize' | 'create_table' | 'chat';
  prompt?: string;
  httpStatus?: number;
}

interface AppState {
  lastOperationContext: OperationContext | null;
  setLastOperationContext: (ctx: OperationContext | null) => void;
  isAssistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  lastOperationContext: null,
  setLastOperationContext: (ctx) => set({ lastOperationContext: ctx }),
  isAssistantOpen: true,
  setAssistantOpen: (open) => set({ isAssistantOpen: open }),
}));
