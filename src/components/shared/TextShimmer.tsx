import React, { useState, useEffect, useRef } from 'react';

/**
 * 文字闪烁动画组件
 * 适配自 OpenCode TextShimmer（SolidJS → React）
 * 通过 CSS 渐变遮罩实现流光效果
 */

interface TextShimmerProps {
  text: string;
  className?: string;
  as?: React.ElementType;
  active?: boolean;
  offset?: number;
}

const SWAP_DELAY = 220;

export const TextShimmer: React.FC<TextShimmerProps> = ({
  text,
  className,
  as: Component = 'span',
  active = true,
  offset = 0,
}) => {
  const [run, setRun] = useState(active);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }

    if (active) {
      setRun(true);
      return;
    }

    // 非活跃时延迟关闭动画，避免突然停止
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      setRun(false);
    }, SWAP_DELAY);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [active]);

  return (
    <Component
      data-component="text-shimmer"
      data-active={active ? 'true' : 'false'}
      className={className}
      aria-label={text}
      style={{
        '--text-shimmer-swap': `${SWAP_DELAY}ms`,
        '--text-shimmer-index': `${offset}`,
      } as React.CSSProperties}
    >
      <span data-slot="text-shimmer-char">
        <span data-slot="text-shimmer-char-base" aria-hidden="true">
          {text}
        </span>
        <span
          data-slot="text-shimmer-char-shimmer"
          data-run={run ? 'true' : 'false'}
          aria-hidden="true"
        >
          {text}
        </span>
      </span>
    </Component>
  );
};
