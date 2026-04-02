import React, { useMemo, useState } from 'react';
import { diffLines, type Change } from 'diff';
import { ChevronDown, ChevronUp, GitCompare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface SqlDiffViewProps {
  originalSql: string;
  optimizedSql: string;
  title?: string;
}

export const SqlDiffView: React.FC<SqlDiffViewProps> = ({ originalSql, optimizedSql, title }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);

  const changes = useMemo(() => diffLines(originalSql, optimizedSql), [originalSql, optimizedSql]);

  // 统计变更行数
  const stats = useMemo(() => {
    let added = 0, removed = 0;
    for (const change of changes) {
      const lineCount = change.value.split('\n').filter(Boolean).length;
      if (change.added) added += lineCount;
      if (change.removed) removed += lineCount;
    }
    return { added, removed };
  }, [changes]);

  return (
    <div className="my-2 rounded-lg border border-border-default overflow-hidden">
      {/* 头部 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-1.5 bg-background-elevated hover:bg-background-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <GitCompare size={12} className="text-accent" />
          <span className="text-[11px] font-medium text-foreground-default">
            {title ?? t('assistant.sqlDiff.title', { defaultValue: 'SQL 优化对比' })}
          </span>
          <span className="text-[10px] text-foreground-ghost">
            <span className="text-diff-add">+{stats.added}</span>
            {' '}
            <span className="text-diff-remove">-{stats.removed}</span>
          </span>
        </div>
        {expanded ? <ChevronUp size={10} className="text-foreground-ghost" /> : <ChevronDown size={10} className="text-foreground-ghost" />}
      </button>

      {/* Diff 内容 */}
      {expanded && (
        <div className="overflow-x-auto bg-background-base">
          <pre className="text-[11px] font-mono leading-[1.6]">
            {changes.map((change, i) => (
              <DiffBlock key={i} change={change} />
            ))}
          </pre>
        </div>
      )}
    </div>
  );
};

const DiffBlock: React.FC<{ change: Change }> = ({ change }) => {
  const lines = change.value.split('\n');
  // 移除末尾空行
  if (lines[lines.length - 1] === '') lines.pop();

  return (
    <>
      {lines.map((line, i) => {
        const prefix = change.added ? '+' : change.removed ? '-' : ' ';
        const bgClass = change.added
          ? 'bg-diff-add-bg'
          : change.removed
            ? 'bg-diff-remove-bg'
            : '';
        const textClass = change.added
          ? 'text-diff-add'
          : change.removed
            ? 'text-diff-remove'
            : 'text-foreground-muted';

        return (
          <div key={i} className={`px-3 ${bgClass}`}>
            <span className={`select-none mr-2 ${textClass} opacity-60`}>{prefix}</span>
            <span className={textClass}>{line}</span>
          </div>
        );
      })}
    </>
  );
};

/**
 * 从 AI 输出中检测标记型 SQL 对比代码块
 * 格式：```sql:original ... ``` 和 ```sql:optimized ... ```
 */
export function parseSqlDiffPair(content: string): { original: string; optimized: string } | null {
  const originalMatch = content.match(/```sql:original\n([\s\S]*?)```/);
  const optimizedMatch = content.match(/```sql:optimized\n([\s\S]*?)```/);

  if (originalMatch && optimizedMatch) {
    return {
      original: originalMatch[1].trim(),
      optimized: optimizedMatch[1].trim(),
    };
  }
  return null;
}
