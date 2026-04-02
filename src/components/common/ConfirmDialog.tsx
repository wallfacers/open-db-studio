import React, { useEffect, useRef } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useConfirmStore } from '../../store/confirmStore';

/**
 * 全局确认框——挂载在 App 根节点，替代 window.confirm()。
 * 通过 useConfirmStore().confirm({ ... }) 命令式调用。
 */
export const ConfirmDialog: React.FC = () => {
  const { t } = useTranslation();
  const { pending, _accept, _cancel } = useConfirmStore();
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  // 打开时聚焦到确认按钮（danger）或取消按钮（default）
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      if (pending.variant === 'danger') {
        cancelBtnRef.current?.focus();
      } else {
        confirmBtnRef.current?.focus();
      }
    }, 30);
    return () => clearTimeout(timer);
  }, [pending]);

  // Escape 取消
  useEffect(() => {
    if (!pending) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') _cancel();
      if (e.key === 'Enter') _accept();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [pending, _accept, _cancel]);

  if (!pending) return null;

  const isDanger = pending.variant === 'danger';
  const Icon = isDanger ? AlertTriangle : Info;

  const confirmCls = isDanger
    ? 'px-4 py-1.5 text-xs rounded bg-error/80 hover:bg-error text-foreground transition-colors'
    : 'px-4 py-1.5 text-xs rounded bg-accent hover:bg-accent-hover text-foreground transition-colors';

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) _cancel(); }}
    >
      <div className="bg-background-panel border border-border-strong rounded-lg shadow-2xl w-[360px] p-5 flex flex-col gap-4">
        {/* 标题行 */}
        <div className="flex items-center gap-2.5">
          <div className={`flex-shrink-0 p-1.5 rounded-full ${isDanger ? 'bg-error-subtle' : 'bg-background-panel'}`}>
            <Icon
              size={16}
              className={isDanger ? 'text-error' : 'text-accent'}
            />
          </div>
          <span className="text-foreground font-medium text-sm">
            {pending.title ?? (isDanger ? t('common.confirmTitle') : t('common.infoTitle'))}
          </span>
        </div>

        {/* 内容 */}
        <p className="text-foreground text-[13px] leading-relaxed pl-[38px]">
          {pending.message}
        </p>

        {/* 按钮区 */}
        <div className="flex justify-end gap-2 pt-1">
          <button
            ref={cancelBtnRef}
            onClick={_cancel}
            className="px-4 py-1.5 text-xs text-foreground-muted hover:text-foreground-default transition-colors"
          >
            {pending.cancelLabel ?? t('common.cancel')}
          </button>
          <button
            ref={confirmBtnRef}
            onClick={_accept}
            className={confirmCls}
          >
            {pending.confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};
