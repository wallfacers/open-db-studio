import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useEscClose } from '../../hooks/useEscClose';
import type { ToastLevel } from '../Toast';

interface Props {
  connectionId: number;
  tableName?: string; // undefined = 新建模式
  onClose: () => void;
  onSuccess: () => void;
  showToast: (msg: string, level?: ToastLevel) => void;
}

export const TableManageDialog: React.FC<Props> = ({
  connectionId, tableName, onClose, onSuccess, showToast
}) => {
  const { t } = useTranslation();
  const [ddl, setDdl] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEscClose(onClose);

  useEffect(() => {
    if (tableName) {
      invoke<string>('get_table_ddl', { connectionId, table: tableName })
        .then(setDdl)
        .catch(e => showToast(String(e), 'error'));
    } else {
      setDdl('CREATE TABLE new_table (\n  id INT PRIMARY KEY AUTO_INCREMENT,\n  name VARCHAR(255) NOT NULL\n);');
    }
  }, [tableName, connectionId]);

  const handleExecute = async () => {
    if (!ddl.trim()) return;
    setIsLoading(true);
    try {
      await invoke('execute_query', { connectionId, sql: ddl });
      showToast(tableName ? t('tableManage.alterSuccess') : t('tableManage.createSuccess'), 'success');
      onSuccess();
      onClose();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDrop = async () => {
    if (!tableName || !window.confirm(t('tableManage.confirmDrop', { table: tableName }))) return;
    setIsLoading(true);
    try {
      await invoke('execute_query', { connectionId, sql: `DROP TABLE \`${tableName}\`` });
      showToast(t('tableManage.dropSuccess'), 'success');
      onSuccess();
      onClose();
    } catch (e) {
      showToast(String(e), 'error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#111922] border border-[#253347] rounded-lg w-[640px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-[#1e2d42]">
          <span className="text-[#c8daea] text-sm font-medium">
            {tableName ? t('tableManage.editTable', { table: tableName }) : t('tableManage.createTable')}
          </span>
          <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea]"><X size={16}/></button>
        </div>
        <textarea
          className="flex-1 m-4 bg-[#0d1520] border border-[#1e2d42] rounded p-3 font-mono text-xs text-[#c8daea] outline-none resize-none min-h-[200px] focus:border-[#009e84]"
          value={ddl}
          onChange={e => setDdl(e.target.value)}
          spellCheck={false}
        />
        <div className="flex justify-between p-4 border-t border-[#1e2d42]">
          {tableName && (
            <button
              onClick={handleDrop}
              disabled={isLoading}
              className="px-3 py-1.5 bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded text-xs disabled:opacity-50"
            >
              {t('tableManage.dropTable')}
            </button>
          )}
          <div className="flex gap-2 ml-auto">
            <button onClick={onClose} className="px-3 py-1.5 bg-[#1a2639] text-[#7a9bb8] hover:text-[#c8daea] rounded text-xs">
              {t('common.cancel')}
            </button>
            <button
              onClick={handleExecute}
              disabled={isLoading}
              className="px-3 py-1.5 bg-[#3794ff] text-[#c8daea] hover:bg-[#2b7cdb] rounded text-xs disabled:opacity-50"
            >
              {isLoading ? t('common.executing') : t('common.execute')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
