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
    if (!await confirm({ message: t('indexManager.confirmDrop', { name: indexName }), variant: 'danger' })) return;
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
      <div className="bg-background-panel border border-border-strong rounded-lg w-[560px] max-h-[70vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border-default">
          <span className="text-foreground-default text-sm font-medium">{t('indexManager.title')} — {tableName}</span>
          <button onClick={onClose} className="text-foreground-muted hover:text-foreground-default transition-colors duration-200"><X size={16}/></button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-foreground-muted border-b border-border-default">
                <th className="text-left py-1 pr-4">{t('indexManager.name')}</th>
                <th className="text-left py-1 pr-4">{t('indexManager.columns')}</th>
                <th className="text-left py-1 pr-4">{t('indexManager.unique')}</th>
                <th className="w-8"/>
              </tr>
            </thead>
            <tbody>
              {indexes.map(idx => (
                <tr key={idx.index_name} className="border-b border-border-default text-foreground-default hover:bg-background-hover transition-colors duration-150">
                  <td className="py-1.5 pr-4">{idx.index_name}</td>
                  <td className="py-1.5 pr-4">{idx.columns.join(', ')}</td>
                  <td className="py-1.5 pr-4">{idx.is_unique ? '✓' : ''}</td>
                  <td>
                    <button onClick={() => handleDrop(idx.index_name)} className="text-foreground-muted hover:text-error p-1 transition-colors duration-200">
                      <Trash2 size={12}/>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {isAdding && (
            <div className="mt-3 p-3 bg-background-base border border-border-default rounded space-y-2">
              <input
                className="w-full bg-background-panel border border-border-strong rounded px-2 py-1 text-xs text-foreground-default outline-none focus:border-border-focus"
                placeholder={t('indexManager.indexName')}
                value={newIndex.name}
                onChange={e => setNewIndex(p => ({...p, name: e.target.value}))}
              />
              <input
                className="w-full bg-background-panel border border-border-strong rounded px-2 py-1 text-xs text-foreground-default outline-none focus:border-border-focus"
                placeholder={t('indexManager.columnsHint')}
                value={newIndex.columns}
                onChange={e => setNewIndex(p => ({...p, columns: e.target.value}))}
              />
              <label className="flex items-center gap-2 text-xs text-foreground-default">
                <input type="checkbox" checked={newIndex.unique} onChange={e => setNewIndex(p => ({...p, unique: e.target.checked}))}/>
                {t('indexManager.uniqueIndex')}
              </label>
              <div className="flex gap-2">
                <button onClick={handleCreate} className="px-3 py-1 bg-primary text-foreground-default text-xs rounded">{t('common.create')}</button>
                <button onClick={() => setIsAdding(false)} className="px-3 py-1 bg-background-hover text-foreground-muted text-xs rounded">{t('common.cancel')}</button>
              </div>
            </div>
          )}
        </div>
        <div className="p-3 border-t border-border-default flex justify-between">
          <button onClick={() => setIsAdding(true)} disabled={isAdding}
            className="flex items-center gap-1 text-xs text-primary hover:opacity-80 disabled:opacity-30">
            <Plus size={12}/> {t('indexManager.addIndex')}
          </button>
          <button onClick={onClose} className="px-3 py-1.5 bg-background-hover text-foreground-muted text-xs rounded">
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
};
