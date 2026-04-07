import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * 流式文本节奏控制 Hook
 * 适配自 OpenCode 的 createPacedValue，实现打字机效果
 *
 * 核心逻辑：将一次性到来的文本 delta 以自适应步长逐步释放，
 * 在单词边界对齐，视觉上呈现平滑的打字动画。
 */

const TEXT_RENDER_PACE_MS = 24;
const TEXT_RENDER_SNAP = /[\s.,!?;:)\]]/;

/** 根据剩余文本长度计算每步释放字符数 */
function step(remaining: number): number {
  if (remaining <= 12) return 2;
  if (remaining <= 48) return 4;
  if (remaining <= 96) return 8;
  return 24;
}

/** 计算下一个释放位置，尽量对齐到单词边界 */
function next(text: string, start: number): number {
  const end = Math.min(text.length, start + step(text.length - start));
  const max = Math.min(text.length, end + 8);
  for (let i = end; i < max; i++) {
    if (TEXT_RENDER_SNAP.test(text[i] ?? '')) return i + 1;
  }
  return end;
}

export function usePacedValue(rawText: string, isLive: boolean): string {
  const [displayed, setDisplayed] = useState(rawText);
  const shownRef = useRef(rawText);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rawTextRef = useRef(rawText);
  const isLiveRef = useRef(isLive);

  rawTextRef.current = rawText;
  isLiveRef.current = isLive;

  const sync = useCallback((text: string) => {
    shownRef.current = text;
    setDisplayed(text);
  }, []);

  const clear = useCallback(() => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  const run = useCallback(() => {
    timerRef.current = undefined;
    const text = rawTextRef.current;

    // 非 live 时立即 snap
    if (!isLiveRef.current) {
      sync(text);
      return;
    }

    // 文本不是追加关系（被截断或完全替换），立即 snap
    if (!text.startsWith(shownRef.current) || text.length <= shownRef.current.length) {
      sync(text);
      return;
    }

    // 逐步释放
    const end = next(text, shownRef.current.length);
    sync(text.slice(0, end));

    // 还有剩余文本，继续调度
    if (end < text.length) {
      timerRef.current = setTimeout(run, TEXT_RENDER_PACE_MS);
    }
  }, [sync]);

  useEffect(() => {
    // 非 live 模式：立即 snap，取消所有 timer
    if (!isLive) {
      clear();
      sync(rawText);
      return;
    }

    // live 模式下文本被截断或替换：立即 snap
    if (!rawText.startsWith(shownRef.current) || rawText.length < shownRef.current.length) {
      clear();
      sync(rawText);
      return;
    }

    // 已经显示到最新、或正在进行中：无需额外调度
    if (rawText.length === shownRef.current.length || timerRef.current !== undefined) {
      return;
    }

    // 调度节奏释放
    timerRef.current = setTimeout(run, TEXT_RENDER_PACE_MS);
  }, [rawText, isLive, clear, sync, run]);

  // 清理
  useEffect(() => {
    return () => clear();
  }, [clear]);

  return displayed;
}
