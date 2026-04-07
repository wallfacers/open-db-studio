import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Code } from 'lucide-react';

interface CellEditorModalProps {
  value: string | null;
  columnName: string;
  onConfirm: (newValue: string | null) => void;
  onClose: () => void;
  readOnly?: boolean;
}

function isJsonLike(value: string): boolean {
  try {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export const CellEditorModal: React.FC<CellEditorModalProps> = ({
  value, columnName, onConfirm, onClose, readOnly = false,
}) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  const [isJson, setIsJson] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setIsJson(draft.length > 0 && isJsonLike(draft));
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, []);

  const handleFormatJson = () => {
    try {
      setDraft(JSON.stringify(JSON.parse(draft), null, 2));
    } catch {}
  };

  const handleConfirm = () => {
    onConfirm(draft === '' && value === null ? null : draft);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleConfirm();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-background-panel border border-border-strong rounded-lg shadow-2xl w-[600px] flex flex-col"
        style={{ maxHeight: '70vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-default">
          <span className="text-foreground-default text-xs font-medium font-mono">{columnName}</span>
          <div className="flex items-center gap-2">
            {isJson && (
              <button
                onClick={handleFormatJson}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-background-hover hover:bg-background-active text-border-focus rounded transition-colors duration-200"
              >
                <Code size={11} />
                {t('tableDataView.formatJson')}
              </button>
            )}
            <button onClick={onClose} className="p-1 hover:bg-background-hover rounded text-foreground-muted transition-colors duration-200">
              <X size={13} />
            </button>
          </div>
        </div>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          className={`flex-1 min-h-[220px] m-4 bg-background-panel border border-border-default rounded p-3 text-foreground-default text-xs font-mono outline-none resize-none focus:border-accent transition-colors ${readOnly ? 'cursor-default select-all' : ''}`}
          value={draft}
          readOnly={readOnly}
          onChange={readOnly ? undefined : e => {
            setDraft(e.target.value);
            setIsJson(e.target.value.length > 0 && isJsonLike(e.target.value));
          }}
          onKeyDown={handleKeyDown}
        />

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border-default">
          {readOnly ? (
            <button
              onClick={onClose}
              className="px-3 py-1 text-xs bg-background-hover hover:bg-background-active text-foreground-default rounded transition-colors duration-200"
            >
              {t('common.close')}
            </button>
          ) : (
            <>
              <span className="text-foreground-subtle text-xs mr-auto">Ctrl+Enter {t('common.confirm')} · Esc {t('common.cancel')}</span>
              <button
                onClick={onClose}
                className="px-3 py-1 text-xs text-foreground-muted hover:text-foreground-default hover:bg-background-hover rounded transition-colors duration-200"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleConfirm}
                className="px-3 py-1 text-xs bg-primary hover:bg-primary-hover text-foreground rounded transition-colors duration-200"
              >
                {t('common.confirm')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
