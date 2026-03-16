import { create } from 'zustand';

export type ConfirmVariant = 'default' | 'danger';

interface PendingConfirm {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
  resolve: (result: boolean) => void;
}

interface ConfirmStore {
  pending: PendingConfirm | null;
  /** 命令式弹出确认框，返回 Promise<boolean> */
  confirm: (opts: Omit<PendingConfirm, 'resolve'>) => Promise<boolean>;
  _accept: () => void;
  _cancel: () => void;
}

export const useConfirmStore = create<ConfirmStore>((set, get) => ({
  pending: null,

  confirm: (opts) =>
    new Promise<boolean>((resolve) => {
      set({ pending: { ...opts, resolve } });
    }),

  _accept: () => {
    get().pending?.resolve(true);
    set({ pending: null });
  },

  _cancel: () => {
    get().pending?.resolve(false);
    set({ pending: null });
  },
}));
