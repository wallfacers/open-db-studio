import { useEffect, RefObject } from 'react';

/**
 * 检测点击发生在指定元素外部，触发回调。
 * active 为 false 时不注册监听器（用于条件激活）。
 */
export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onClickOutside: () => void,
  active = true,
): void {
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClickOutside();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, onClickOutside, active]);
}
