import React, { useState, useRef, useEffect } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface CategoryEditModalProps {
  parentNode?: { label: string };
  connectionId?: number;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}

export function CategoryEditModal({
  parentNode,
  onClose,
  onSave,
}: CategoryEditModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-background-panel border border-border-strong rounded-lg shadow-2xl w-80"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-strong">
          <span className="text-sm font-medium text-foreground-default">{t('seaTunnel.categoryModal.newTitle')}</span>
          <button className="text-foreground-muted hover:text-foreground-default transition-colors" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-3">
          {parentNode && (
            <div className="text-xs text-foreground-muted">
              {t('seaTunnel.categoryModal.parentCategory')}：<span className="text-foreground-default">{parentNode.label}</span>
            </div>
          )}
          <div>
            <label className="block text-xs text-foreground-muted mb-1">{t('seaTunnel.categoryModal.categoryName')}</label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('seaTunnel.categoryModal.namePlaceholder')}
              className="w-full bg-background-base border border-border-strong rounded px-3 py-1.5 text-sm text-foreground-default placeholder-foreground-muted outline-none focus:border-accent transition-colors"
            />
          </div>
          {error && <div className="text-xs text-error">{error}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-foreground-muted hover:text-foreground-default border border-border-strong rounded transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-3 py-1.5 text-xs text-background-base bg-accent hover:bg-accent-hover rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? t('common.saving') : t('common.create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
