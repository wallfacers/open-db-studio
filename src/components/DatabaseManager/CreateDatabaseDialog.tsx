// src/components/DatabaseManager/CreateDatabaseDialog.tsx
import React, { useState } from 'react';
import { X, Database } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

interface Props {
  connectionId: number;
  driver: string;  // 'mysql' | 'postgres' | 'sqlite'
  onClose: () => void;
  onSuccess: (dbName: string, switchTo: boolean) => void;
}

export const CreateDatabaseDialog: React.FC<Props> = ({
  connectionId,
  driver,
  onClose,
  onSuccess,
}) => {
  const [name, setName] = useState('');
  const [charset, setCharset] = useState('utf8mb4');
  const [collation, setCollation] = useState('utf8mb4_general_ci');
  const [defaultSchema, setDefaultSchema] = useState('public');
  const [switchAfterCreate, setSwitchAfterCreate] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('数据库名称不能为空');
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      await invoke('create_database', {
        connectionId,
        name: name.trim(),
        options: {
          charset: driver === 'mysql' ? charset : null,
          collation: driver === 'mysql' ? collation : null,
          default_schema: driver === 'postgres' ? defaultSchema : null,
          tablespace: null,
        },
      });
      onSuccess(name.trim(), switchAfterCreate);
      onClose();
    } catch (e: any) {
      setError(e?.toString() ?? '创建失败');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#0d1520] border border-[#1e2d42] rounded-lg w-[400px]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e2d42]">
          <div className="flex items-center gap-2">
            <Database size={14} className="text-[#3794ff]" />
            <h3 className="text-sm text-[#e8f4ff] font-medium">新建数据库</h3>
          </div>
          <button onClick={onClose} className="text-[#7a9bb8] hover:text-[#c8daea]">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <label className="block text-xs text-[#7a9bb8] mb-1">
              数据库名称 <span className="text-[#f44747]">*</span>
            </label>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              placeholder="my_new_db"
              className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none focus:border-[#3794ff]"
              autoFocus
            />
          </div>

          {driver === 'mysql' && (
            <>
              <div>
                <label className="block text-xs text-[#7a9bb8] mb-1">字符集 (MySQL)</label>
                <select
                  value={charset}
                  onChange={(e) => setCharset(e.target.value)}
                  className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none"
                >
                  <option value="utf8mb4">utf8mb4</option>
                  <option value="utf8">utf8</option>
                  <option value="latin1">latin1</option>
                  <option value="gbk">gbk</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#7a9bb8] mb-1">排序规则 (MySQL)</label>
                <select
                  value={collation}
                  onChange={(e) => setCollation(e.target.value)}
                  className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none"
                >
                  <option value="utf8mb4_general_ci">utf8mb4_general_ci</option>
                  <option value="utf8mb4_unicode_ci">utf8mb4_unicode_ci</option>
                  <option value="utf8mb4_0900_ai_ci">utf8mb4_0900_ai_ci</option>
                </select>
              </div>
            </>
          )}

          {driver === 'postgres' && (
            <div>
              <label className="block text-xs text-[#7a9bb8] mb-1">默认 Schema 名称 (PostgreSQL)</label>
              <input
                value={defaultSchema}
                onChange={(e) => setDefaultSchema(e.target.value)}
                placeholder="public"
                className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1.5 text-xs text-[#c8daea] outline-none"
              />
            </div>
          )}

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={switchAfterCreate}
              onChange={(e) => setSwitchAfterCreate(e.target.checked)}
              className="accent-[#3794ff]"
            />
            <span className="text-xs text-[#c8daea]">创建后立即切换到该数据库</span>
          </label>

          {error && (
            <div className="text-xs text-[#f44747] bg-[#f44747]/10 px-2 py-1.5 rounded border border-[#f44747]/30">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-[#1e2d42]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleCreate}
            disabled={isLoading || !name.trim()}
            className="px-3 py-1.5 text-xs bg-[#1a4a8a] text-[#3794ff] border border-[#3794ff]/50 rounded hover:bg-[#1e5a9a] transition-colors disabled:opacity-40"
          >
            {isLoading ? '创建中...' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
};
