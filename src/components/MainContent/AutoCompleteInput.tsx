import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '../common/Tooltip';

interface AutoCompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  onSearch: () => void;
  placeholder?: string;
  columns: string[];
  className?: string;
}

export const AutoCompleteInput: React.FC<AutoCompleteInputProps> = ({
  value,
  onChange,
  onSearch,
  placeholder,
  columns,
  className = '',
}) => {
  const { t } = useTranslation();
  const [inputValue, setInputValue] = useState(value);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<number | null>(null);

  // 同步外部 value 变化
  useEffect(() => {
    setInputValue(value);
  }, [value]);

  // 使用 useMemo 缓存列名的小写版本，避免每次重复计算
  const lowerCaseColumns = useMemo(() => {
    return columns.map(col => ({
      original: col,
      lower: col.toLowerCase(),
    }));
  }, [columns]);

  // 提取当前正在输入的词（光标前的词）
  const getCurrentWord = useCallback((input: HTMLInputElement): { word: string; start: number; end: number } => {
    const cursorPos = input.selectionStart || 0;
    const text = input.value;

    // 找到当前词的开始和结束位置（词边界是空格、逗号、括号、运算符等）
    const wordBoundary = /[\s,()=<>!+\-*/]+/;

    let start = cursorPos;
    while (start > 0 && !wordBoundary.test(text[start - 1])) {
      start--;
    }

    let end = cursorPos;
    while (end < text.length && !wordBoundary.test(text[end])) {
      end++;
    }

    return { word: text.slice(start, end), start, end };
  }, []);

  // 根据输入过滤列名建议
  const filterSuggestions = useCallback((inputWord: string) => {
    if (!inputWord || inputWord.length < 1) {
      setShowSuggestions(false);
      return;
    }

    const lowerInput = inputWord.toLowerCase();
    // 使用缓存的小写列名进行过滤
    const filtered = lowerCaseColumns
      .filter(col => col.lower.includes(lowerInput))
      .map(col => col.original)
      .slice(0, 8); // 最多显示8个

    if (filtered.length > 0) {
      setShowSuggestions(true);
      setHighlightIndex(0);
    } else {
      setShowSuggestions(false);
    }
  }, [lowerCaseColumns]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);

    // 清除之前的防抖定时器
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
    }

    // 使用防抖延迟过滤，避免频繁计算
    debounceRef.current = window.setTimeout(() => {
      if (inputRef.current) {
        const { word } = getCurrentWord(inputRef.current);
        filterSuggestions(word);
      }
    }, 150); // 150ms 防抖延迟
  };

  const handleBlur = () => {
    onChange(inputValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions) {
      if (e.key === 'Enter') {
        e.preventDefault();
        // 先同步当前输入值，再触发搜索
        onChange(inputValue);
        onSearch();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightIndex(prev => {
          // 使用函数式更新避免依赖 suggestions 长度
          const maxIndex = Math.min(7, lowerCaseColumns.length - 1);
          return (prev + 1) % (maxIndex + 1);
        });
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightIndex(prev => {
          const maxIndex = Math.min(7, lowerCaseColumns.length - 1);
          return (prev - 1 + (maxIndex + 1)) % (maxIndex + 1);
        });
        break;
      case 'Enter':
        e.preventDefault();
        // 从当前过滤结果中获取高亮项
        if (inputRef.current) {
          const { word } = getCurrentWord(inputRef.current);
          const lowerInput = word.toLowerCase();
          const filtered = lowerCaseColumns
            .filter(col => col.lower.includes(lowerInput))
            .map(col => col.original)
            .slice(0, 8);

          if (filtered[highlightIndex]) {
            applySuggestion(filtered[highlightIndex]);
          } else {
            // 没有匹配项时直接触发搜索
            onChange(inputValue);
            onSearch();
          }
        }
        break;
      case 'Escape':
        setShowSuggestions(false);
        break;
    }
  };

  const applySuggestion = (suggestion: string) => {
    if (!inputRef.current) return;

    const { word, start, end } = getCurrentWord(inputRef.current);
    const newValue = inputValue.slice(0, start) + suggestion + inputValue.slice(end);
    setInputValue(newValue);
    onChange(newValue);
    setShowSuggestions(false);

    // 恢复光标位置
    setTimeout(() => {
      if (inputRef.current) {
        const newCursorPos = start + suggestion.length;
        inputRef.current.setSelectionRange(newCursorPos, newCursorPos);
        inputRef.current.focus();
      }
    }, 0);
  };

  // 清理防抖定时器
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, []);

  // 点击外部关闭建议列表
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 计算当前显示的建议列表
  const currentSuggestions = useMemo(() => {
    if (!showSuggestions || !inputRef.current) return [];
    const { word } = getCurrentWord(inputRef.current);
    if (!word) return [];

    const lowerInput = word.toLowerCase();
    return lowerCaseColumns
      .filter(col => col.lower.includes(lowerInput))
      .map(col => col.original)
      .slice(0, 8);
  }, [showSuggestions, lowerCaseColumns, getCurrentWord, inputValue]);

  return (
    <div ref={containerRef} className="relative flex items-center flex-1">
      <input
        ref={inputRef}
        className={`bg-transparent outline-none text-[var(--foreground-default)] w-full ${className}`}
        placeholder={placeholder}
        value={inputValue}
        onChange={handleInputChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        autoComplete="off"
      />

      {/* 搜索图标 */}
      <Tooltip content={t('tableDataView.search')}>
        <button
          onClick={onSearch}
          className="p-1 hover:bg-[var(--background-hover)] rounded text-[var(--foreground-muted)] hover:text-[var(--accent)] transition-colors ml-1 flex-shrink-0"
        >
          <Search size={14} />
        </button>
      </Tooltip>

      {/* 自动补全下拉列表 - 宽度自适应内容 */}
      {showSuggestions && currentSuggestions.length > 0 && (
        <div className="absolute top-full left-0 mt-1 bg-[var(--background-elevated)] border border-[var(--border-strong)] rounded shadow-lg z-50 max-h-40 overflow-y-auto min-w-[120px] w-auto whitespace-nowrap">
          {currentSuggestions.map((col, idx) => (
            <div
              key={col}
              className={`px-3 py-1.5 text-xs cursor-pointer ${
                idx === highlightIndex
                  ? 'bg-[var(--background-hover)] text-[var(--accent)]'
                  : 'text-[var(--foreground-default)] hover:bg-[var(--background-hover)]'
              }`}
              onMouseDown={e => e.preventDefault()}
              onClick={() => applySuggestion(col)}
              onMouseEnter={() => setHighlightIndex(idx)}
            >
              {col}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
