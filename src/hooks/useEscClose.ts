import { useEffect } from 'react';

/**
 * 为全屏遮罩弹窗添加 ESC 键关闭支持。
 * 与点击右上角 X 按钮效果相同。
 */
export function useEscClose(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, enabled]);
}
