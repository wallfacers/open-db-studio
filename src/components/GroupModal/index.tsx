import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { FolderOpen, X } from 'lucide-react';

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

  const [name, setName]     = useState(group?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[#0d1117] border border-[#2a3f5a] rounded-lg shadow-2xl w-72 p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <FolderOpen size={16} className="text-[#00c9a7]" />
            <span className="text-[#c8daea] font-medium text-sm">
              {isEdit ? t('groupModal.editTitle') : t('groupModal.createTitle')}
            </span>
          </div>
          <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea] transition-colors"><X size={16} /></button>
        </div>

        <label className="block text-xs text-[#7a9bb8] mb-1">{t('groupModal.name')}</label>
        <input
          autoFocus
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
          placeholder={t('groupModal.namePlaceholder')}
          className="w-full bg-[#151d28] border border-[#2a3f5a] rounded px-3 py-1.5 text-sm
                     text-[#c8daea] outline-none focus:border-[#00a98f] transition-colors mb-3"
        />

        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-xs bg-[#00a98f] hover:bg-[#00c9a7] disabled:opacity-50
                       text-white rounded transition-colors"
          >
            {saving ? t('groupModal.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
};
