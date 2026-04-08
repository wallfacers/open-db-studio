import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { BaseModal } from './BaseModal';

interface PromptModalProps {
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  onClose: () => void;
  onConfirm: (value: string) => void | Promise<void>;
  validate?: (value: string) => string | null;
}

export const PromptModal: React.FC<PromptModalProps> = ({
  title,
  label,
  initialValue = '',
  placeholder = '',
  onClose,
  onConfirm,
  validate,
}) => {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 聚焦并全选
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, []);

  const handleConfirm = async () => {
    const val = value.trim();
    if (!val) {
      setError(t('commonComponents.prompt.required', { defaultValue: 'Value is required' }));
      return;
    }
    if (validate) {
      const err = validate(val);
      if (err) {
        setError(err);
        return;
      }
    }
    
    try {
      setLoading(true);
      await onConfirm(val);
    } catch (e: any) {
      setError(e.message || 'Error');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    }
  };

  return (
    <BaseModal
      title={title}
      onClose={onClose}
      width={400}
      footerButtons={[
        { label: t('common.cancel'), onClick: onClose, variant: 'secondary' },
        { label: t('common.confirm'), onClick: handleConfirm, variant: 'primary', loading },
      ]}
    >
      <div className="flex flex-col gap-2">
        <label className="text-[13px] text-foreground-default font-medium">{label}</label>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="w-full bg-background-base border border-border-strong rounded px-3 py-1.5 text-[13px] text-foreground-default placeholder-foreground-muted focus:border-accent-hover outline-none transition-colors"
        />
        {error && <span className="text-error text-xs">{error}</span>}
      </div>
    </BaseModal>
  );
};
