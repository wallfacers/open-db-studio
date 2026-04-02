import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

interface Group {
  id: number;
  name: string;
}

interface GroupModalProps {
  group?: Group;
  onClose: () => void;
  onSuccess: () => void;
}

export const GroupModal: React.FC<GroupModalProps> = ({ group, onClose, onSuccess }) => {
  const { t } = useTranslation();
  const isEdit = !!group;

  const [name, setName] = useState(group?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError(t('groupModal.nameRequired')); return; }
    setSaving(true);
    setError('');
    try {
      if (isEdit) {
        await invoke('update_group', { id: group!.id, req: { name: trimmed, color: null } });
      } else {
        await invoke('create_group', { req: { name: trimmed, color: null } });
      }
      onSuccess();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const inputClass = 'w-full bg-background-hover border border-border-strong rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-border-focus';
  const labelClass = 'block text-xs text-foreground-muted mb-1';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-background-panel border border-border-strong rounded-lg w-[480px] p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-foreground font-semibold">{isEdit ? t('groupModal.editTitle') : t('groupModal.createTitle')}</h2>
          <button onClick={onClose} className="text-foreground-muted hover:text-foreground-default transition-colors"><X size={16} /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className={labelClass}>{t('groupModal.name')}</label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
              placeholder={t('groupModal.namePlaceholder')}
              className={inputClass}
            />
          </div>
        </div>

        {error && <p className="text-xs text-error mt-2">{error}</p>}

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose}
            className="px-3 py-1.5 text-sm bg-background-hover hover:bg-border-strong text-foreground rounded transition-colors duration-200">
            {t('common.cancel')}
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-3 py-1.5 text-sm bg-accent hover:bg-accent-hover text-foreground rounded disabled:opacity-50 transition-colors duration-200">
            {saving ? t('groupModal.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
};
