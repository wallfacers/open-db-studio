import React, { useEffect, useRef, useState } from 'react';
import { Bell, CheckCircle, AlertTriangle, XCircle, Info, Copy, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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
    bg: 'var(--success-subtle)',
    border: 'var(--success)',
    color: 'var(--success-foreground)',
    Icon: CheckCircle,
  },
  warning: {
    bg: 'var(--warning-subtle)',
    border: 'var(--warning)',
    color: 'var(--warning-foreground)',
    Icon: AlertTriangle,
  },
  error: {
    bg: 'var(--error-subtle)',
    border: 'var(--error)',
    color: 'var(--error-foreground)',
    Icon: XCircle,
  },
  info: {
    bg: 'var(--info-subtle)',
    border: 'var(--info)',
    color: 'var(--info-foreground)',
    Icon: Info,
  },
  default: {
    bg: 'var(--accent-subtle)',
    border: 'var(--accent)',
    color: 'var(--accent)',
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
  const { t } = useTranslation();
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
        title={copied ? t('commonComponents.toast.copied') : t('commonComponents.toast.copy')}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      {markdownContext && onAskAi && (
        <button
          onClick={() => { onAskAi(); }}
          className="ml-1 px-1.5 py-0.5 rounded text-xs opacity-80 hover:opacity-100 hover:bg-white/10 transition-all flex items-center gap-1"
          title={t('commonComponents.toast.askAi')}
        >
          🤖 {t('commonComponents.toast.askAi')}
        </button>
      )}
    </div>
  );
};
