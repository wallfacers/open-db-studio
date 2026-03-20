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
  ghostTextDefault: boolean;
  setGhostTextDefault: (enabled: boolean) => Promise<void>;
  initGhostTextDefault: () => Promise<void>;
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
  setGhostTextDefault: async (enabled: boolean) => {
    set({ ghostTextDefault: enabled });
    try {
      await invoke('set_ui_state', { key: 'ghost_text_default', value: JSON.stringify(enabled) });
    } catch (e) {
      console.error('Failed to set ghost_text_default:', e);
    }
  },
  initGhostTextDefault: async () => {
    try {
      const raw = await invoke<string | null>('get_ui_state', { key: 'ghost_text_default' });
      if (raw !== null) {
        set({ ghostTextDefault: JSON.parse(raw) === true });
      }
      // raw 为 null 时保持默认值 true（首次启动）
    } catch (e) {
      console.error('Failed to get ghost_text_default:', e);
    }
  },
}));
