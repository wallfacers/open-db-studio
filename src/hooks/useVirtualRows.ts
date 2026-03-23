import { useVirtualizer } from '@tanstack/react-virtual';
import type { RefObject } from 'react';

/**
 * 行级虚拟滚动 hook，封装 @tanstack/react-virtual 的 useVirtualizer。
 *
 * @param count       - 总行数（当前页数据行 + 克隆行）
 * @param scrollRef   - 外层滚动容器的 ref，需设置 overflow-auto 且有明确高度
 * @returns           - Virtualizer 实例，包含 getVirtualItems() 和 getTotalSize()
 */
export function useVirtualRows(
  count: number,
  scrollRef: RefObject<HTMLDivElement | null>
) {
  return useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28, // py-1.5(12px) + text-xs line-height(16px) = 28px
    overscan: 5,
  });
}
