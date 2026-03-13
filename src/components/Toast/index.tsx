import React, { useEffect, useRef, useState } from 'react';
import { Bell, CheckCircle, AlertTriangle, XCircle, Info, Copy, Check } from 'lucide-react';

export type ToastLevel = 'success' | 'warning' | 'error' | 'info' | 'default';

interface ToastProps {
  message: string | null;
  level?: ToastLevel;
  duration?: number;
  onClose?: () => void;
  markdownContext?: string | null;
  onAskAi?: () => void;
}

const LEVEL_CONFIG: Record<ToastLevel, {
  bg: string;
  border: string;
  color: string;
  Icon: React.ElementType;
}> = {
  success: {
    bg: '#14532d',
    border: '#4ade80',
    color: '#86efac',
    Icon: CheckCircle,
  },
  warning: {
    bg: '#78350f',
    border: '#f59e0b',
    color: '#fcd34d',
    Icon: AlertTriangle,
  },
  error: {
    bg: '#881337',
    border: '#f43f5e',
    color: '#fda4af',
    Icon: XCircle,
  },
  info: {
    bg: '#1e3a5f',
    border: '#5eb2f7',
    color: '#93c5fd',
    Icon: Info,
  },
  default: {
    bg: '#134e4a',
    border: '#00c9a7',
    color: '#5eead4',
    Icon: Bell,
  },
};

export const Toast: React.FC<ToastProps> = ({
  message,
  level = 'default',
  duration = 3000,
  onClose,
  markdownContext,
  onAskAi,
}) => {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);

  const startTimer = () => {
    if (!onClose) return;
    timerRef.current = setTimeout(onClose, duration);
  };

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    if (!message) return;
    startTimer();
    return clearTimer;
  }, [message]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCopy = async () => {
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore copy failure
    }
  };

  if (!message) return null;

  const { bg, border, color, Icon } = LEVEL_CONFIG[level];
  return (
    <div
      className="fixed top-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded shadow-lg z-50 flex items-center space-x-2 text-[13px]"
      style={{
        background: bg,
        borderTop: `1px solid ${border}55`,
        borderRight: `1px solid ${border}55`,
        borderBottom: `1px solid ${border}55`,
        borderLeft: `3px solid ${border}`,
        color,
      }}
      onMouseEnter={clearTimer}
      onMouseLeave={startTimer}
    >
      <Icon size={15} />
      <span className="cursor-text select-text">{message}</span>
      <button
        onClick={handleCopy}
        className="ml-1 p-0.5 rounded opacity-60 hover:opacity-100 hover:bg-white/10 transition-all"
        title={copied ? '已复制' : '复制'}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      {markdownContext && onAskAi && (
        <button
          onClick={() => { onAskAi(); }}
          className="ml-1 px-1.5 py-0.5 rounded text-xs opacity-80 hover:opacity-100 hover:bg-white/10 transition-all flex items-center gap-1"
          title="问 AI"
        >
          🤖 问 AI
        </button>
      )}
    </div>
  );
};
