import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

interface PasswordInputProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
  /** 编辑模式：value 为空时点眼睛触发，返回真实值用于显示（不写入 form state） */
  onReveal?: () => Promise<string>;
}

export function PasswordInput({ value, onChange, className = '', placeholder = '', onReveal }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const [revealed, setRevealed] = useState('');

  const handleToggle = async () => {
    const next = !visible;
    setVisible(next);
    if (next && !value && onReveal) {
      try {
        const real = await onReveal();
        setRevealed(real);
      } catch {}
    }
    if (!next) {
      setRevealed('');
    }
  };

  const displayValue = visible ? (revealed || value) : value;

  return (
    <div className="relative">
      <input
        type={visible ? 'text' : 'password'}
        value={displayValue}
        onChange={(e) => { setRevealed(''); onChange(e.target.value); }}
        placeholder={placeholder}
        className={`${className} pr-8 no-password-reveal`}
      />
      <button
        type="button"
        onClick={handleToggle}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--foreground-muted)] hover:text-[var(--foreground-default)]"
        tabIndex={-1}
      >
        {visible ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}
