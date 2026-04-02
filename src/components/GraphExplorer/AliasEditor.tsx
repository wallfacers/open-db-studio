import React, { useState, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, Plus, Save, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { parseAliases } from './graphUtils';

interface AliasEditorProps {
  nodeId: string;
  nodeName: string;
  currentAliases: string;
  onSave: () => void;
  onClose: () => void;
}

export const AliasEditor: React.FC<AliasEditorProps> = ({
  nodeId,
  nodeName,
  currentAliases,
  onSave,
  onClose,
}) => {
  const { t } = useTranslation();
  const [aliases, setAliases] = useState<string[]>(parseAliases(currentAliases));
  const [inputValue, setInputValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleAddAlias = () => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    if (aliases.includes(trimmed)) {
      setError(t('graphExplorer.aliasEditor.aliasExists'));
      return;
    }
    setAliases((prev) => [...prev, trimmed]);
    setInputValue('');
    setError(null);
  };

  const handleRemoveAlias = (alias: string) => {
    setAliases((prev) => prev.filter((a) => a !== alias));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddAlias();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const aliasesJson = JSON.stringify(aliases);
      await invoke('update_node_alias', { nodeId, aliases: aliasesJson });
      onSave();
    } catch (err) {
      const msg = typeof err === 'string' ? err : (err as Error)?.message ?? t('graphExplorer.aliasEditor.saveFailed');
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
      <div className="bg-background-panel border border-border-default rounded-lg shadow-2xl w-[420px] max-w-[90vw]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
          <div>
            <h3 className="text-foreground-default text-sm font-semibold">{t('graphExplorer.aliasEditor.title')}</h3>
            <p className="text-foreground-muted text-xs mt-0.5 truncate max-w-[300px]">{nodeName}</p>
          </div>
          <button
            onClick={onClose}
            className="text-foreground-muted hover:text-foreground-default transition-colors p-1 rounded hover:bg-border-default"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-4 space-y-3">
          {/* Current aliases */}
          <div className="space-y-1.5">
            <p className="text-foreground-muted text-xs">{t('graphExplorer.aliasEditor.currentAliases')}</p>
            {aliases.length === 0 ? (
              <p className="text-foreground-muted text-xs italic">{t('graphExplorer.aliasEditor.noAliases')}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {aliases.map((alias) => (
                  <span
                    key={alias}
                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-background-base border border-border-default rounded text-foreground-default text-xs"
                  >
                    {alias}
                    <button
                      onClick={() => handleRemoveAlias(alias)}
                      className="text-foreground-muted hover:text-error transition-colors"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Add alias input */}
          <div className="space-y-1.5">
            <p className="text-foreground-muted text-xs">{t('graphExplorer.aliasEditor.addNewAlias')}</p>
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={(e) => {
                  setInputValue(e.target.value);
                  setError(null);
                }}
                onKeyDown={handleKeyDown}
                placeholder={t('graphExplorer.aliasEditor.placeholder')}
                className="flex-1 px-3 py-1.5 text-sm bg-background-base border border-border-default rounded text-foreground-default placeholder-foreground-ghost focus:outline-none focus:border-accent/50 transition-colors"
              />
              <button
                onClick={handleAddAlias}
                disabled={!inputValue.trim()}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-background-hover hover:bg-border-strong border border-border-strong rounded text-foreground-default disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Plus size={13} />
                {t('graphExplorer.aliasEditor.add')}
              </button>
            </div>
            {error && (
              <p className="text-error text-xs">{error}</p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border-default">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-foreground-muted hover:text-foreground-default hover:bg-border-default rounded transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent/10 hover:bg-accent/20 border border-accent/30 rounded text-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
};
