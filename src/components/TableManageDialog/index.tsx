import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

interface Props {
  connectionId: number;
  tableName?: string; // undefined = 新建模式
  onClose: () => void;
  onSuccess: () => void;
  showToast: (msg: string) => void;
}

export const TableManageDialog: React.FC<Props> = ({
  connectionId, tableName, onClose, onSuccess, showToast
}) => {
  const { t } = useTranslation();
  const [ddl, setDdl] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (tableName) {
      invoke<string>('get_table_ddl', { connectionId, table: tableName })
        .then(setDdl)
        .catch(e => showToast(String(e)));
    } else {
      setDdl('CREATE TABLE new_table (\n  id INT PRIMARY KEY AUTO_INCREMENT,\n  name VARCHAR(255) NOT NULL\n);');
    }
  }, [tableName, connectionId]);

  const handleExecute = async () => {
    if (!ddl.trim()) return;
    setIsLoading(true);
    try {
      await invoke('execute_query', { connectionId, sql: ddl });
      showToast(tableName ? t('tableManage.alterSuccess') : t('tableManage.createSuccess'));
      onSuccess();
      onClose();
    } catch (e) {
      showToast(String(e));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDrop = async () => {
    if (!tableName || !window.confirm(t('tableManage.confirmDrop', { table: tableName }))) return;
    setIsLoading(true);
    try {
      await invoke('execute_query', { connectionId, sql: `DROP TABLE \`${tableName}\`` });
      showToast(t('tableManage.dropSuccess'));
      onSuccess();
      onClose();
    } catch (e) {
      showToast(String(e));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg w-[640px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-[#2b2b2b]">
          <span className="text-[#d4d4d4] text-sm font-medium">
            {tableName ? t('tableManage.editTable', { table: tableName }) : t('tableManage.createTable')}
          </span>
          <button onClick={onClose} className="text-[#858585] hover:text-[#d4d4d4]"><X size={16}/></button>
        </div>
        <textarea
          className="flex-1 m-4 bg-[#141414] border border-[#2b2b2b] rounded p-3 font-mono text-xs text-[#d4d4d4] outline-none resize-none min-h-[200px]"
          value={ddl}
          onChange={e => setDdl(e.target.value)}
          spellCheck={false}
        />
        <div className="flex justify-between p-4 border-t border-[#2b2b2b]">
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
            <button onClick={onClose} className="px-3 py-1.5 bg-[#2b2b2b] text-[#858585] hover:text-[#d4d4d4] rounded text-xs">
              {t('common.cancel')}
            </button>
            <button
              onClick={handleExecute}
              disabled={isLoading}
              className="px-3 py-1.5 bg-[#3794ff] text-white hover:bg-[#2b7cdb] rounded text-xs disabled:opacity-50"
            >
              {isLoading ? t('common.executing') : t('common.execute')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
