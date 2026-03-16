import { useConfirmStore, type ConfirmVariant } from '../store/confirmStore';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
}

/**
 * 返回命令式 confirm 函数，替代 window.confirm()。
 *
 * @example
 * const confirm = useConfirm();
 * const ok = await confirm({ message: '确认删除？', variant: 'danger' });
 * if (!ok) return;
 */
export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  return useConfirmStore((s) => s.confirm);
}
