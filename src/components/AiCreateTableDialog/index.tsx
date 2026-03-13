import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { X, Sparkles } from 'lucide-react';
import { useConnectionStore, useAiStore } from '../../store';
import { useEscClose } from '../../hooks/useEscClose';
import type { ToastLevel } from '../Toast';

interface Props {
  onClose: () => void;
  showToast: (msg: string, level?: ToastLevel) => void;
  onRefresh: () => void;
}

export const AiCreateTableDialog: React.FC<Props> = ({ onClose, showToast, onRefresh }) => {
  const { t } = useTranslation();
  const { activeConnectionId } = useConnectionStore();
  const { createTable, isCreatingTable } = useAiStore();
  const [description, setDescription] = useState('');
  const [generatedDdl, setGeneratedDdl] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);

  useEscClose(onClose);

  const handleGenerate = async () => {
    if (!activeConnectionId || !description.trim()) return;
    try {
      const ddl = await createTable(description, activeConnectionId);
      setGeneratedDdl(ddl);
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  const handleExecute = async () => {
    if (!activeConnectionId || !generatedDdl.trim()) return;
    setIsExecuting(true);
    try {
      await invoke('execute_query', { connectionId: activeConnectionId, sql: generatedDdl });
      showToast(t('aiCreateTable.success'), 'success');
      onRefresh();
      onClose();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#111922] border border-[#253347] rounded-lg w-[640px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-[#1e2d42]">
          <div className="flex items-center gap-2 text-[#c8daea] text-sm font-medium">
            <Sparkles size={14} className="text-[#00c9a7]"/>
            {t('aiCreateTable.title')}
          </div>
          <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea]"><X size={16}/></button>
        </div>
        <div className="flex-1 overflow-auto p-4 flex flex-col gap-3">
          <div>
            <label className="text-xs text-[#7a9bb8] mb-1 block">{t('aiCreateTable.describeTable')}</label>
            <textarea
              className="w-full bg-[#0d1520] border border-[#1e2d42] rounded p-3 text-xs text-[#c8daea] outline-none resize-none h-24 focus:border-[#009e84]"
              placeholder={t('aiCreateTable.descriptionPlaceholder')}
              value={description}
              onChange={e => setDescription(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) handleGenerate(); }}
            />
          </div>
          <button
            onClick={handleGenerate}
            disabled={isCreatingTable || !description.trim() || !activeConnectionId}
            className="flex items-center gap-2 px-4 py-2 bg-[#00c9a7] text-[#0d1520] text-xs font-medium rounded disabled:opacity-50 w-fit hover:bg-[#00b396] transition-colors"
          >
            <Sparkles size={12}/>
            {isCreatingTable ? t('aiCreateTable.generating') : t('aiCreateTable.generate')}
          </button>
          {generatedDdl && (
            <div className="flex-1 flex flex-col">
              <label className="text-xs text-[#7a9bb8] mb-1">{t('aiCreateTable.reviewDdl')}</label>
              <textarea
                className="flex-1 bg-[#0d1520] border border-[#1e2d42] rounded p-3 font-mono text-xs text-[#c8daea] outline-none resize-none min-h-[150px] focus:border-[#009e84]"
                value={generatedDdl}
                onChange={e => setGeneratedDdl(e.target.value)}
                spellCheck={false}
              />
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-[#1e2d42]">
          <button onClick={onClose} className="px-3 py-1.5 bg-[#1a2639] text-[#7a9bb8] text-xs rounded">
            {t('common.cancel')}
          </button>
          {generatedDdl && (
            <button
              onClick={handleExecute}
              disabled={isExecuting}
              className="px-3 py-1.5 bg-[#00c9a7] text-[#0d1520] text-xs font-medium rounded disabled:opacity-50 hover:bg-[#00b396] transition-colors"
            >
              {isExecuting ? t('common.executing') : t('aiCreateTable.executeAndCreate')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
