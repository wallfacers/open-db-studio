import { create } from 'zustand';
import type { ToastLevel } from '../components/Toast';

interface ToastState {
  message: string | null;
  level: ToastLevel;
  markdownContext: string | null;
  show: (msg: string, level?: ToastLevel) => void;
  showError: (msg: string, markdownContext?: string | null) => void;
  hide: () => void;
}

export const useToastStore = create<ToastState>((set) => ({
  message: null,
  level: 'default',
  markdownContext: null,
  show: (msg, level = 'default') => set({ message: msg, level, markdownContext: null }),
  showError: (msg, markdownContext = null) => set({ message: msg, level: 'error', markdownContext }),
  hide: () => set({ message: null }),
}));
