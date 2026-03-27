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
  tablePageSizeLimit: number;
  setTablePageSizeLimit: (size: number) => Promise<void>;
  initTablePageSizeLimit: () => Promise<void>;
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
  tablePageSizeLimit: 1000,
  setTablePageSizeLimit: async (size: number) => {
    set({ tablePageSizeLimit: size });
    try {
      await invoke('set_ui_state', { key: 'table_page_size_limit', value: String(size) });
    } catch (e) {
      console.error('Failed to set table_page_size_limit:', e);
    }
  },
  initTablePageSizeLimit: async () => {
    try {
      const raw = await invoke<string | null>('get_ui_state', { key: 'table_page_size_limit' });
      if (raw) {
        const size = Number(raw);
        if (!isNaN(size) && size > 0) set({ tablePageSizeLimit: size });
      }
    } catch (e) {
      console.error('Failed to get table_page_size_limit:', e);
    }
  },
}));
