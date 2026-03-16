import React, { useEffect } from 'react';
import { X } from 'lucide-react';

interface FooterButton {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  loading?: boolean;
  disabled?: boolean;
}

interface BaseModalProps {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  /** 底部按钮列表，留空则隐藏 footer */
  footerButtons?: FooterButton[];
  /** footer 左侧额外内容（如提示文字） */
  footerHint?: React.ReactNode;
  /** 弹框宽度，默认 480 */
  width?: number | string;
  /** 额外 className 作用于弹框面板 */
  className?: string;
  /** 是否点击遮罩层关闭，默认 true */
  closeOnBackdrop?: boolean;
}

const VARIANT_CLASS: Record<string, string> = {
  primary:   'px-4 py-1.5 text-xs bg-[#009e84] hover:bg-[#00c9a7] disabled:opacity-50 text-white rounded transition-colors',
  secondary: 'px-3 py-1.5 text-xs text-[#7a9bb8] hover:text-[#c8daea] transition-colors',
  danger:    'px-4 py-1.5 text-xs bg-red-600/20 hover:bg-red-600/30 disabled:opacity-50 text-red-400 rounded transition-colors',
};

export const BaseModal: React.FC<BaseModalProps> = ({
  title,
  onClose,
  children,
  footerButtons,
  footerHint,
  width = 480,
  className = '',
  closeOnBackdrop = true,
}) => {
  // Escape 键关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (closeOnBackdrop && e.target === e.currentTarget) onClose(); }}
    >
      <div
        className={`bg-[#111922] border border-[#253347] rounded-lg shadow-2xl flex flex-col ${className}`}
        style={{ width }}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#1e2d42] flex-shrink-0">
          <div className="text-[#c8daea] font-medium text-sm flex items-center gap-2">
            {title}
          </div>
          <button
            onClick={onClose}
            className="text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* 内容区 */}
        <div className="p-5 overflow-y-auto">
          {children}
        </div>

        {/* 底部按钮 */}
        {footerButtons && footerButtons.length > 0 && (
          <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-[#1e2d42] bg-[#0d1117] flex-shrink-0">
            <div className="text-xs text-[#7a9bb8]">{footerHint}</div>
            <div className="flex items-center gap-2">
              {footerButtons.map((btn) => (
                <button
                  key={btn.label}
                  onClick={btn.onClick}
                  disabled={btn.disabled || btn.loading}
                  className={VARIANT_CLASS[btn.variant ?? 'secondary']}
                >
                  {btn.loading ? '处理中...' : btn.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
