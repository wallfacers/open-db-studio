import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Trash2, Plus, X } from 'lucide-react';
import type { IndexMeta, TableDetail } from '../../types';
import { useEscClose } from '../../hooks/useEscClose';
import { useConfirm } from '../../hooks/useConfirm';
import type { ToastLevel } from '../Toast';

interface Props {
  connectionId: number;
  tableName: string;
  onClose: () => void;
  showToast: (msg: string, level?: ToastLevel) => void;
}

export const IndexManager: React.FC<Props> = ({ connectionId, tableName, onClose, showToast }) => {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [indexes, setIndexes] = useState<IndexMeta[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [newIndex, setNewIndex] = useState({ name: '', columns: '', unique: false });

  useEscClose(onClose);

  const loadIndexes = () => {
    invoke<TableDetail>('get_table_detail', { connectionId, table: tableName })
      .then(d => setIndexes(d.indexes))
      .catch(e => showToast(String(e), 'error'));
  };

  useEffect(() => { loadIndexes(); }, [connectionId, tableName]);

  const handleDrop = async (indexName: string) => {
    if (!await confirm({ message: `${t('indexManager.confirmDrop')} "${indexName}"?`, variant: 'danger' })) return;
    try {
      await invoke('execute_query', {
        connectionId,
        sql: `DROP INDEX \`${indexName}\` ON \`${tableName}\``,
      });
      showToast(t('indexManager.dropSuccess'), 'success');
      loadIndexes();
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  const handleCreate = async () => {
    if (!newIndex.name.trim() || !newIndex.columns.trim()) {
      showToast(t('indexManager.nameAndColumnsRequired'), 'warning');
      return;
    }
    const unique = newIndex.unique ? 'UNIQUE ' : '';
    const sql = `CREATE ${unique}INDEX \`${newIndex.name}\` ON \`${tableName}\` (${newIndex.columns})`;
    try {
      await invoke('execute_query', { connectionId, sql });
      showToast(t('indexManager.createSuccess'), 'success');
      setIsAdding(false);
      setNewIndex({ name: '', columns: '', unique: false });
      loadIndexes();
    } catch (e) {
      showToast(String(e), 'error');
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[#111922] border border-[#253347] rounded-lg w-[560px] max-h-[70vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-[#1e2d42]">
          <span className="text-[#c8daea] text-sm font-medium">{t('indexManager.title')} — {tableName}</span>
          <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea]"><X size={16}/></button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[#7a9bb8] border-b border-[#1e2d42]">
                <th className="text-left py-1 pr-4">{t('indexManager.name')}</th>
                <th className="text-left py-1 pr-4">{t('indexManager.columns')}</th>
                <th className="text-left py-1 pr-4">{t('indexManager.unique')}</th>
                <th className="w-8"/>
              </tr>
            </thead>
            <tbody>
              {indexes.map(idx => (
                <tr key={idx.index_name} className="border-b border-[#1e2d42] text-[#c8daea] hover:bg-[#1a2639]">
                  <td className="py-1.5 pr-4">{idx.index_name}</td>
                  <td className="py-1.5 pr-4">{idx.columns.join(', ')}</td>
                  <td className="py-1.5 pr-4">{idx.is_unique ? '✓' : ''}</td>
                  <td>
                    <button onClick={() => handleDrop(idx.index_name)} className="text-[#7a9bb8] hover:text-red-400 p-1">
                      <Trash2 size={12}/>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {isAdding && (
            <div className="mt-3 p-3 bg-[#0d1520] border border-[#1e2d42] rounded space-y-2">
              <input
                className="w-full bg-[#111922] border border-[#253347] rounded px-2 py-1 text-xs text-[#c8daea] outline-none focus:border-[#009e84]"
                placeholder={t('indexManager.indexName')}
                value={newIndex.name}
                onChange={e => setNewIndex(p => ({...p, name: e.target.value}))}
              />
              <input
                className="w-full bg-[#111922] border border-[#253347] rounded px-2 py-1 text-xs text-[#c8daea] outline-none focus:border-[#009e84]"
                placeholder={t('indexManager.columnsHint')}
                value={newIndex.columns}
                onChange={e => setNewIndex(p => ({...p, columns: e.target.value}))}
              />
              <label className="flex items-center gap-2 text-xs text-[#c8daea]">
                <input type="checkbox" checked={newIndex.unique} onChange={e => setNewIndex(p => ({...p, unique: e.target.checked}))}/>
                {t('indexManager.uniqueIndex')}
              </label>
              <div className="flex gap-2">
                <button onClick={handleCreate} className="px-3 py-1 bg-[#3794ff] text-[#c8daea] text-xs rounded">{t('common.create')}</button>
                <button onClick={() => setIsAdding(false)} className="px-3 py-1 bg-[#1a2639] text-[#7a9bb8] text-xs rounded">{t('common.cancel')}</button>
              </div>
            </div>
          )}
        </div>
        <div className="p-3 border-t border-[#1e2d42] flex justify-between">
          <button onClick={() => setIsAdding(true)} disabled={isAdding}
            className="flex items-center gap-1 text-xs text-[#3794ff] hover:opacity-80 disabled:opacity-30">
            <Plus size={12}/> {t('indexManager.addIndex')}
          </button>
          <button onClick={onClose} className="px-3 py-1.5 bg-[#1a2639] text-[#7a9bb8] text-xs rounded">
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
};
