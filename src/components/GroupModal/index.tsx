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

  const inputClass = 'w-full bg-[var(--background-hover)] border border-[var(--border-strong)] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#009e84]';
  const labelClass = 'block text-xs text-gray-400 mb-1';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[var(--background-panel)] border border-[var(--border-strong)] rounded-lg w-[480px] p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-semibold">{isEdit ? t('groupModal.editTitle') : t('groupModal.createTitle')}</h2>
          <button onClick={onClose} className="text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] transition-colors"><X size={16} /></button>
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

        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose}
            className="px-3 py-1.5 text-sm bg-[var(--background-hover)] hover:bg-[var(--border-strong)] text-white rounded">
            {t('common.cancel')}
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-3 py-1.5 text-sm bg-[#009e84] hover:bg-[#007a62] text-white rounded disabled:opacity-50">
            {saving ? t('groupModal.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
};
