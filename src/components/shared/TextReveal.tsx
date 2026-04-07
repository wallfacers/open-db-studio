import React, { useState, useEffect, useRef, useCallback } from 'react';

/**
 * 文字切换动画组件
 * 适配自 OpenCode TextReveal（SolidJS → React）
 * 通过 CSS mask + 宽度过渡实现平滑文本替换
 */

interface TextRevealProps {
  text?: string;
  className?: string;
  duration?: number | string;
  /** 渐变边缘柔和度百分比 (0 = 硬切, 17 = 柔和) */
  edge?: number;
  /** 进入文本的垂直位移 (px) */
  travel?: number | string;
  spring?: string;
  springSoft?: string;
  /** 只增长不缩小（除非完全换文本） */
  growOnly?: boolean;
  truncate?: boolean;
}

const px = (v: number | string | undefined, fb: number) =>
  typeof v === 'number' ? `${v}px` : typeof v === 'string' ? v : `${fb}px`;
const ms = (v: number | string | undefined, fb: number) =>
  typeof v === 'number' ? `${v}ms` : typeof v === 'string' ? v : `${fb}ms`;
const pct = (v: number | undefined, fb: number) => `${v ?? fb}%`;

export const TextReveal: React.FC<TextRevealProps> = ({
  text,
  className,
  duration,
  edge,
  travel,
  spring,
  springSoft,
  growOnly = true,
  truncate = false,
}) => {
  const [state, setState] = useState({
    cur: text,
    old: undefined as string | undefined,
    width: 'auto',
    ready: false,
    swapping: false,
  });

  const inRef = useRef<HTMLSpanElement>(null);
  const outRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const frameRef = useRef<number>();
  const widthRef = useRef(state.width);

  const widen = useCallback(
    (nextW: number) => {
      if (nextW <= 0) return;
      if (growOnly) {
        const prev = parseFloat(widthRef.current);
        if (Number.isFinite(prev) && nextW <= prev) return;
      }
      const w = `${nextW}px`;
      widthRef.current = w;
      setState((s) => ({ ...s, width: w }));
    },
    [growOnly],
  );

  // 监听 text 变化
  useEffect(() => {
    if (text === state.cur) return;

    const prev = state.cur;

    // 如果新文本是旧文本的追加（如流式场景），直接更新无需动画
    if (typeof text === 'string' && typeof prev === 'string' && text.startsWith(prev)) {
      setState((s) => ({ ...s, cur: text }));
      if (inRef.current) widen(inRef.current.scrollWidth);
      return;
    }

    // 完全换文本：触发切换动画
    setState((s) => ({ ...s, swapping: true, old: prev, cur: text }));

    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      const win = inRef.current?.scrollWidth ?? 0;
      const wout = outRef.current?.scrollWidth ?? 0;
      widen(Math.max(win, wout));
      rootRef.current?.offsetHeight; // force reflow
      setState((s) => ({ ...s, swapping: false }));
      frameRef.current = undefined;
    });
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  // mount 时初始化宽度
  useEffect(() => {
    if (inRef.current) widen(inRef.current.scrollWidth);
    if (typeof document !== 'undefined' && document.fonts) {
      document.fonts.ready.finally(() => {
        if (inRef.current) widen(inRef.current.scrollWidth);
        requestAnimationFrame(() => setState((s) => ({ ...s, ready: true })));
      });
    } else {
      requestAnimationFrame(() => setState((s) => ({ ...s, ready: true })));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  return (
    <span
      ref={rootRef}
      data-component="text-reveal"
      data-ready={state.ready ? 'true' : 'false'}
      data-swapping={state.swapping ? 'true' : 'false'}
      data-truncate={truncate ? 'true' : 'false'}
      className={className}
      aria-label={text ?? ''}
      style={
        {
          '--text-reveal-duration': ms(duration, 450),
          '--text-reveal-edge': pct(edge, 17),
          '--text-reveal-travel': px(travel, 0),
          '--text-reveal-spring': spring ?? 'cubic-bezier(0.34, 1.08, 0.64, 1)',
          '--text-reveal-spring-soft': springSoft ?? 'cubic-bezier(0.34, 1, 0.64, 1)',
        } as React.CSSProperties
      }
    >
      <span
        data-slot="text-reveal-track"
        style={{ width: truncate ? '100%' : state.width }}
      >
        <span data-slot="text-reveal-entering" ref={inRef}>
          {state.cur ?? '\u00A0'}
        </span>
        <span data-slot="text-reveal-leaving" ref={outRef}>
          {state.old ?? '\u00A0'}
        </span>
      </span>
    </span>
  );
};
