import React, { useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, Table2, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { QueryResult } from '../../types';

interface InlineResultCardProps {
  result: QueryResult;
  sql: string;
  onOpenInQueryTab?: (sql: string) => void;
}

const MAX_INLINE_ROWS = 10;

export const InlineResultCard: React.FC<InlineResultCardProps> = ({ result, sql, onOpenInQueryTab }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const isError = result.kind === 'error';
  const isDml = result.kind === 'dml-report';
  const hasMoreRows = result.rows.length > MAX_INLINE_ROWS;
  const displayRows = expanded ? result.rows : result.rows.slice(0, MAX_INLINE_ROWS);

  return (
    <div className={`my-2 rounded-lg border overflow-hidden ${
      isError ? 'border-error-subtle' : 'border-border-default'
    }`}>
      {/* 头部统计信息 */}
      <div className="flex items-center justify-between px-2.5 py-1.5 bg-background-elevated text-[11px]">
        <div className="flex items-center gap-2">
          {isError ? (
            <AlertCircle size={11} className="text-error" />
          ) : (
            <Table2 size={11} className="text-accent" />
          )}
          <span className="text-foreground-default font-medium">
            {isError
              ? t('assistant.inlineResult.error', { defaultValue: '执行错误' })
              : isDml
                ? t('assistant.inlineResult.dml', { defaultValue: `影响 ${result.row_count} 行` })
                : t('assistant.inlineResult.rows', { defaultValue: `${result.row_count} 行` })
            }
          </span>
          <span className="text-foreground-ghost">
            {result.duration_ms}ms
          </span>
        </div>
        {onOpenInQueryTab && (
          <button
            onClick={() => onOpenInQueryTab(sql)}
            className="flex items-center gap-1 text-foreground-ghost hover:text-accent transition-colors"
            title={t('assistant.inlineResult.openInTab', { defaultValue: '在查询面板打开' })}
          >
            <ExternalLink size={10} />
            <span>{t('assistant.inlineResult.openInTab', { defaultValue: '查询面板' })}</span>
          </button>
        )}
      </div>

      {/* 错误信息 */}
      {isError && result.error_message && (
        <div className="px-2.5 py-2 bg-error-subtle text-[11px] text-error font-mono">
          {result.error_message}
        </div>
      )}

      {/* 数据表格 */}
      {!isError && result.columns.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="bg-background-panel">
                {result.columns.map((col, i) => (
                  <th key={i} className="border-b border-border-default px-2 py-1 text-left font-medium text-foreground-muted whitespace-nowrap">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row, ri) => (
                <tr key={ri} className="hover:bg-background-hover">
                  {row.map((cell, ci) => (
                    <td key={ci} className="border-b border-border-default px-2 py-1 text-foreground-default whitespace-nowrap max-w-[200px] truncate font-mono">
                      {cell === null ? (
                        <span className="text-foreground-ghost italic">NULL</span>
                      ) : (
                        String(cell)
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 展开/折叠更多行 */}
      {hasMoreRows && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-center gap-1 py-1 text-[10px] text-foreground-ghost hover:text-foreground-muted transition-colors bg-background-elevated border-t border-border-default"
        >
          {expanded ? (
            <>
              <ChevronUp size={10} />
              {t('assistant.inlineResult.collapse', { defaultValue: '收起' })}
            </>
          ) : (
            <>
              <ChevronDown size={10} />
              {t('assistant.inlineResult.showMore', { defaultValue: `显示全部 ${result.rows.length} 行` })}
            </>
          )}
        </button>
      )}
    </div>
  );
};
