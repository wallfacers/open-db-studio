import React, { useState, useRef, useEffect } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { STTreeNode } from '../../store/seaTunnelStore';

interface CategoryEditModalProps {
  mode: 'create' | 'rename';
  parentNode?: STTreeNode;
  existingName?: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}

export function CategoryEditModal({
  mode,
  parentNode,
  existingName,
  onClose,
  onSave,
}: CategoryEditModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(existingName ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // 检查深度限制（最多3层，depth 0-based，最大 depth=2）
  const depthError =
    mode === 'create' && parentNode && (parentNode.meta.depth ?? 0) >= 2
      ? t('seaTunnel.categoryModal.depthError')
      : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (depthError) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('seaTunnel.categoryModal.nameRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      onClose();
    } catch (err: any) {
      setError(err?.message ?? t('seaTunnel.categoryModal.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  const title = mode === 'create' ? t('seaTunnel.categoryModal.newTitle') : t('seaTunnel.categoryModal.renameTitle');
  const submitLabel = mode === 'create' ? t('common.create') : t('common.save');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-[#111922] border border-[#253347] rounded-lg shadow-2xl w-80"
        onKeyDown={handleKeyDown}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#253347]">
          <span className="text-sm font-medium text-[#c8daea]">{title}</span>
          <button
            className="text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {/* 表单 */}
        <form onSubmit={handleSubmit} className="p-4 space-y-3">
          {depthError && (
            <div className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 rounded px-3 py-2">
              {depthError}
            </div>
          )}

          {mode === 'create' && parentNode && !depthError && (
            <div className="text-xs text-[#7a9bb8]">
              {t('seaTunnel.categoryModal.parentCategory')}：<span className="text-[#c8daea]">{parentNode.label}</span>
            </div>
          )}

          <div>
            <label className="block text-xs text-[#7a9bb8] mb-1">{t('seaTunnel.categoryModal.categoryName')}</label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('seaTunnel.categoryModal.namePlaceholder')}
              disabled={!!depthError}
              className="w-full bg-[#0d1117] border border-[#253347] rounded px-3 py-1.5 text-sm text-[#c8daea] placeholder-[#7a9bb8] outline-none focus:border-[#00c9a7] transition-colors disabled:opacity-50"
            />
          </div>

          {error && (
            <div className="text-xs text-red-400">{error}</div>
          )}

          {/* 操作按钮 */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-[#7a9bb8] hover:text-[#c8daea] border border-[#253347] rounded transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={saving || !!depthError}
              className="px-3 py-1.5 text-xs text-[#0d1117] bg-[#00c9a7] hover:bg-[#00a98f] rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? t('common.saving') : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
