// src/store/appStore.ts
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

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
  autoMode: boolean;
  setAutoMode: (enabled: boolean) => void;
  initAutoMode: () => Promise<void>;
  ghostTextDefault: boolean;  // Ghost Text 全局默认开关（Task 6 完整实现持久化）
  setGhostTextDefault: (enabled: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  lastOperationContext: null,
  setLastOperationContext: (ctx) => set({ lastOperationContext: ctx }),
  isAssistantOpen: true,
  setAssistantOpen: (open) => set({ isAssistantOpen: open }),
  autoMode: false,
  setAutoMode: async (enabled: boolean) => {
    set({ autoMode: enabled });
    try {
      await invoke('set_auto_mode', { enabled });
    } catch (e) {
      console.error('Failed to set auto mode:', e);
    }
  },
  initAutoMode: async () => {
    try {
      const enabled = await invoke<boolean>('get_auto_mode');
      set({ autoMode: enabled });
    } catch (e) {
      console.error('Failed to get auto mode:', e);
    }
  },
  ghostTextDefault: true,
  setGhostTextDefault: (enabled) => set({ ghostTextDefault: enabled }),
}));
