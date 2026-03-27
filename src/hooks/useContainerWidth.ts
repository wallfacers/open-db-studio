import { useState, useLayoutEffect, type RefObject } from 'react';

/**
 * 通过 ResizeObserver 监听容器宽度变化，返回容器的像素宽度。
 * 首次渲染后立即同步测量，后续变化防抖 80ms。
 */
export function useContainerWidth(ref: RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    setWidth(el.clientWidth);

    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      clearTimeout(timer);
      timer = setTimeout(() => setWidth(entry.contentRect.width), 80);
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [ref]);

  return width;
}
