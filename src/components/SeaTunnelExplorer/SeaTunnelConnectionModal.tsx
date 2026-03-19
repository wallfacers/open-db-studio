import React, { useState, useRef, useEffect } from 'react';
import { X, Eye, EyeOff } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

interface ConnectionData {
  id: number;
  name: string;
  url: string;
}

interface SeaTunnelConnectionModalProps {
  mode: 'create' | 'edit';
  connection?: ConnectionData;
  onClose: () => void;
  onSave: () => void;
}

export function SeaTunnelConnectionModal({
  mode,
  connection,
  onClose,
  onSave,
}: SeaTunnelConnectionModalProps) {
  const [name, setName] = useState(connection?.name ?? '');
  const [url, setUrl] = useState(connection?.url ?? '');
  const [authToken, setAuthToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName) {
      setError('连接名称不能为空');
      return;
    }
    if (!trimmedUrl) {
      setError('集群地址不能为空');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (mode === 'create') {
        await invoke('create_st_connection', {
          name: trimmedName,
          url: trimmedUrl,
          authToken: authToken.trim() || null,
        });
      } else if (connection) {
        await invoke('update_st_connection', {
          id: connection.id,
          name: trimmedName,
          url: trimmedUrl,
          authToken: authToken.trim() || null,
        });
      }
      onSave();
      onClose();
    } catch (err: any) {
      setError(err?.message ?? '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  const title = mode === 'create' ? '新建集群连接' : '编辑集群连接';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-[#111922] border border-[#253347] rounded-lg shadow-2xl w-96"
        onKeyDown={handleKeyDown}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#253347]">
          <span className="text-sm font-medium text-[#c8daea]">{title}</span>
          <button
            className="text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {/* 表单 */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* 名称 */}
          <div>
            <label className="block text-xs text-[#7a9bb8] mb-1">
              连接名称 <span className="text-red-400">*</span>
            </label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="例如：生产集群"
              className="w-full bg-[#0d1117] border border-[#253347] rounded px-3 py-1.5 text-sm text-[#c8daea] placeholder-[#7a9bb8] outline-none focus:border-[#00c9a7] transition-colors"
            />
          </div>

          {/* 集群地址 */}
          <div>
            <label className="block text-xs text-[#7a9bb8] mb-1">
              集群地址 <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="http://host:5801"
              className="w-full bg-[#0d1117] border border-[#253347] rounded px-3 py-1.5 text-sm text-[#c8daea] placeholder-[#7a9bb8] outline-none focus:border-[#00c9a7] transition-colors"
            />
          </div>

          {/* Auth Token（可选） */}
          <div>
            <label className="block text-xs text-[#7a9bb8] mb-1">
              Auth Token <span className="text-[#7a9bb8]">（可选）</span>
            </label>
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={authToken}
                onChange={e => setAuthToken(e.target.value)}
                placeholder="Bearer token 或留空"
                className="w-full bg-[#0d1117] border border-[#253347] rounded px-3 py-1.5 pr-9 text-sm text-[#c8daea] placeholder-[#7a9bb8] outline-none focus:border-[#00c9a7] transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowToken(v => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
              >
                {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {error && (
            <div className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 rounded px-3 py-2">
              {error}
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-[#7a9bb8] hover:text-[#c8daea] border border-[#253347] rounded transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-3 py-1.5 text-xs text-[#0d1117] bg-[#00c9a7] hover:bg-[#00a98f] rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
