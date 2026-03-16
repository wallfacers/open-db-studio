import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import { BaseModal } from '../common/BaseModal';

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
    <BaseModal
      title={<><FolderOpen size={16} className="text-[#00c9a7]" />{isEdit ? t('groupModal.editTitle') : t('groupModal.createTitle')}</>}
      onClose={onClose}
      width={288}
      footerButtons={[
        { label: t('common.cancel'), onClick: onClose, variant: 'secondary' },
        { label: saving ? t('groupModal.saving') : t('common.save'), onClick: handleSave, variant: 'primary', loading: saving },
      ]}
    >
      <label className="block text-xs text-[#7a9bb8] mb-1">{t('groupModal.name')}</label>
      <input
        autoFocus
        type="text"
        value={name}
        onChange={(e) => { setName(e.target.value); setError(''); }}
        onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
        placeholder={t('groupModal.namePlaceholder')}
        className="w-full bg-[#1a2639] border border-[#253347] rounded px-3 py-1.5 text-sm
                   text-[#c8daea] outline-none focus:border-[#00c9a7] transition-colors"
      />
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </BaseModal>
  );
};
