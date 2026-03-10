import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { X, Sparkles } from 'lucide-react';
import { useConnectionStore, useAiStore } from '../../store';

interface Props {
  onClose: () => void;
  showToast: (msg: string) => void;
  onRefresh: () => void;
}

export const AiCreateTableDialog: React.FC<Props> = ({ onClose, showToast, onRefresh }) => {
  const { t } = useTranslation();
  const { activeConnectionId } = useConnectionStore();
  const { createTable, isCreatingTable } = useAiStore();
  const [description, setDescription] = useState('');
  const [generatedDdl, setGeneratedDdl] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);

  const handleGenerate = async () => {
    if (!activeConnectionId || !description.trim()) return;
    try {
      const ddl = await createTable(description, activeConnectionId);
      setGeneratedDdl(ddl);
    } catch (e) {
      showToast(String(e));
    }
  };

  const handleExecute = async () => {
    if (!activeConnectionId || !generatedDdl.trim()) return;
    setIsExecuting(true);
    try {
      await invoke('execute_query', { connectionId: activeConnectionId, sql: generatedDdl });
      showToast(t('aiCreateTable.success'));
      onRefresh();
      onClose();
    } catch (e) {
      showToast(String(e));
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg w-[640px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-[#2b2b2b]">
          <div className="flex items-center gap-2 text-[#d4d4d4] text-sm font-medium">
            <Sparkles size={14} className="text-[#3794ff]"/>
            {t('aiCreateTable.title')}
          </div>
          <button onClick={onClose} className="text-[#858585] hover:text-[#d4d4d4]"><X size={16}/></button>
        </div>
        <div className="flex-1 overflow-auto p-4 flex flex-col gap-3">
          <div>
            <label className="text-xs text-[#858585] mb-1 block">{t('aiCreateTable.describeTable')}</label>
            <textarea
              className="w-full bg-[#141414] border border-[#2b2b2b] rounded p-3 text-xs text-[#d4d4d4] outline-none resize-none h-24"
              placeholder={t('aiCreateTable.descriptionPlaceholder')}
              value={description}
              onChange={e => setDescription(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) handleGenerate(); }}
            />
          </div>
          <button
            onClick={handleGenerate}
            disabled={isCreatingTable || !description.trim() || !activeConnectionId}
            className="flex items-center gap-2 px-4 py-2 bg-[#3794ff] text-white text-xs rounded disabled:opacity-50 w-fit"
          >
            <Sparkles size={12}/>
            {isCreatingTable ? t('aiCreateTable.generating') : t('aiCreateTable.generate')}
          </button>
          {generatedDdl && (
            <div className="flex-1 flex flex-col">
              <label className="text-xs text-[#858585] mb-1">{t('aiCreateTable.reviewDdl')}</label>
              <textarea
                className="flex-1 bg-[#141414] border border-[#2b2b2b] rounded p-3 font-mono text-xs text-[#d4d4d4] outline-none resize-none min-h-[150px]"
                value={generatedDdl}
                onChange={e => setGeneratedDdl(e.target.value)}
                spellCheck={false}
              />
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-[#2b2b2b]">
          <button onClick={onClose} className="px-3 py-1.5 bg-[#2b2b2b] text-[#858585] text-xs rounded">
            {t('common.cancel')}
          </button>
          {generatedDdl && (
            <button
              onClick={handleExecute}
              disabled={isExecuting}
              className="px-3 py-1.5 bg-[#3794ff] text-white text-xs rounded disabled:opacity-50"
            >
              {isExecuting ? t('common.executing') : t('aiCreateTable.executeAndCreate')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
