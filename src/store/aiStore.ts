import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { LlmSettings } from '../types';

interface AiState {
  isGenerating: boolean;
  isExplaining: boolean;
  settings: LlmSettings | null;
  error: string | null;

  loadSettings: () => Promise<void>;
  saveSettings: (settings: LlmSettings) => Promise<void>;
  generateSql: (prompt: string, connectionId: number) => Promise<string>;
  explainSql: (sql: string, connectionId: number) => Promise<string>;
}

export const useAiStore = create<AiState>((set) => ({
  isGenerating: false,
  isExplaining: false,
  settings: null,
  error: null,

  loadSettings: async () => {
    try {
      const settings = await invoke<LlmSettings>('get_llm_settings');
      set({ settings });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  saveSettings: async (settings) => {
    await invoke('set_llm_settings', { settings });
    set({ settings });
  },

  generateSql: async (prompt, connectionId) => {
    set({ isGenerating: true, error: null });
    try {
      const sql = await invoke<string>('ai_generate_sql', { prompt, connectionId });
      return sql;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ isGenerating: false });
    }
  },

  explainSql: async (sql, connectionId) => {
    set({ isExplaining: true, error: null });
    try {
      const explanation = await invoke<string>('ai_explain_sql', { sql, connectionId });
      return explanation;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ isExplaining: false });
    }
  },
}));
