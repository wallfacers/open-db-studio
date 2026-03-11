import React from 'react';
import { Bell, CheckCircle, AlertTriangle, XCircle, Info } from 'lucide-react';

export type ToastLevel = 'success' | 'warning' | 'error' | 'info' | 'default';

interface ToastProps {
  message: string | null;
  level?: ToastLevel;
}

const LEVEL_CONFIG: Record<ToastLevel, {
  bg: string;
  border: string;
  color: string;
  Icon: React.ElementType;
}> = {
  success: {
    bg: 'rgba(74,222,128,0.12)',
    border: '#4ade80',
    color: '#4ade80',
    Icon: CheckCircle,
  },
  warning: {
    bg: 'rgba(245,158,11,0.12)',
    border: '#f59e0b',
    color: '#f59e0b',
    Icon: AlertTriangle,
  },
  error: {
    bg: 'rgba(244,63,94,0.12)',
    border: '#f43f5e',
    color: '#f43f5e',
    Icon: XCircle,
  },
  info: {
    bg: 'rgba(94,178,247,0.12)',
    border: '#5eb2f7',
    color: '#5eb2f7',
    Icon: Info,
  },
  default: {
    bg: 'rgba(0,201,167,0.12)',
    border: '#00c9a7',
    color: '#00c9a7',
    Icon: Bell,
  },
};

export const Toast: React.FC<ToastProps> = ({ message, level = 'default' }) => {
  if (!message) return null;
  const { bg, border, color, Icon } = LEVEL_CONFIG[level];
  return (
    <div
      className="fixed top-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded shadow-lg z-50 transition-opacity flex items-center space-x-2 text-[13px]"
      style={{
        background: bg,
        border: `1px solid ${border}33`,
        borderLeft: `3px solid ${border}`,
        color,
      }}
    >
      <Icon size={15} />
      <span>{message}</span>
    </div>
  );
};
