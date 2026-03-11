import React, { useEffect, useRef } from 'react';
import { Bell, CheckCircle, AlertTriangle, XCircle, Info } from 'lucide-react';

export type ToastLevel = 'success' | 'warning' | 'error' | 'info' | 'default';

interface ToastProps {
  message: string | null;
  level?: ToastLevel;
  duration?: number;
  onClose?: () => void;
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
}) => {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  if (!message) return null;

  const { bg, border, color, Icon } = LEVEL_CONFIG[level];
  return (
    <div
      className="fixed top-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded shadow-lg z-50 flex items-center space-x-2 text-[13px] select-none"
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
      <span>{message}</span>
    </div>
  );
};
