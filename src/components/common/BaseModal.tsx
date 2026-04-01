import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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
  primary:   'px-4 py-1.5 text-xs bg-[#009e84] hover:bg-[var(--accent)] disabled:opacity-50 text-white rounded transition-colors',
  secondary: 'px-3 py-1.5 text-xs text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] transition-colors',
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
  const { t } = useTranslation();

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
        className={`bg-[var(--background-panel)] border border-[var(--border-strong)] rounded-lg shadow-2xl flex flex-col ${className}`}
        style={{ width }}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)] flex-shrink-0">
          <div className="text-[var(--foreground-default)] font-medium text-sm flex items-center gap-2">
            {title}
          </div>
          <button
            onClick={onClose}
            className="text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] transition-colors"
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
          <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-[var(--border-default)] bg-[var(--background-base)] flex-shrink-0">
            <div className="text-xs text-[var(--foreground-muted)]">{footerHint}</div>
            <div className="flex items-center gap-2">
              {footerButtons.map((btn) => (
                <button
                  key={btn.label}
                  onClick={btn.onClick}
                  disabled={btn.disabled || btn.loading}
                  className={VARIANT_CLASS[btn.variant ?? 'secondary']}
                >
                  {btn.loading ? t('commonComponents.baseModal.processing') : btn.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
