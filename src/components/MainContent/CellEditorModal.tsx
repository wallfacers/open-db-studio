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
        className="bg-[#0d1117] border border-[#1e2d42] rounded-lg shadow-2xl w-[600px] flex flex-col"
        style={{ maxHeight: '70vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#1e2d42]">
          <span className="text-[#c8daea] text-xs font-medium font-mono">{columnName}</span>
          <div className="flex items-center gap-2">
            {isJson && (
              <button
                onClick={handleFormatJson}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-[#1a2639] hover:bg-[#243a55] text-[#3a7bd5] rounded"
              >
                <Code size={11} />
                {t('tableDataView.formatJson')}
              </button>
            )}
            <button onClick={onClose} className="p-1 hover:bg-[#1a2639] rounded text-[#7a9bb8]">
              <X size={13} />
            </button>
          </div>
        </div>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          className={`flex-1 min-h-[220px] p-3 bg-[#080d12] text-[#c8daea] text-xs font-mono outline-none resize-y ${readOnly ? 'cursor-default select-all' : ''}`}
          style={{ border: 'none' }}
          value={draft}
          readOnly={readOnly}
          onChange={readOnly ? undefined : e => {
            setDraft(e.target.value);
            setIsJson(e.target.value.length > 0 && isJsonLike(e.target.value));
          }}
          onKeyDown={handleKeyDown}
        />

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-[#1e2d42]">
          {readOnly ? (
            <button
              onClick={onClose}
              className="px-3 py-1 text-xs bg-[#1a2639] hover:bg-[#243a55] text-[#c8daea] rounded"
            >
              {t('common.close')}
            </button>
          ) : (
            <>
              <span className="text-[#4a6b8a] text-xs mr-auto">Ctrl+Enter {t('common.confirm')} · Esc {t('common.cancel')}</span>
              <button
                onClick={onClose}
                className="px-3 py-1 text-xs text-[#7a9bb8] hover:text-[#c8daea] hover:bg-[#1a2639] rounded"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleConfirm}
                className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded"
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
