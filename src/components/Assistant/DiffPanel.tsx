import React, { useMemo } from 'react';
import { Check, X } from 'lucide-react';
import { diffLines } from 'diff';
import type { SqlDiffProposal } from '../../types';

interface DiffPanelProps {
  proposal: SqlDiffProposal;
  onApply: () => void;
  onCancel: () => void;
}

export const DiffPanel: React.FC<DiffPanelProps> = ({ proposal, onApply, onCancel }) => {
  // diffLines 使用 LCS 算法，正确处理重复行和多行变更
  const parts = useMemo(
    () => diffLines(proposal.original, proposal.modified),
    [proposal.original, proposal.modified]
  );

  return (
    <div className="border-t border-[#1e2d42] bg-[#0d1117]">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#1e2d42]">
        <span className="text-xs font-medium text-[#c8daea]">修改建议</span>
        <button
          onClick={onCancel}
          className="text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
          title="取消"
        >
          <X size={14} />
        </button>
      </div>

      {/* 原因说明 */}
      {proposal.reason && (
        <div className="px-3 py-1.5 text-xs text-[#7a9bb8] bg-[#0d1117] border-b border-[#1e2d42]">
          {proposal.reason}
        </div>
      )}

      {/* Diff 内容 */}
      <div className="overflow-x-auto font-mono text-xs max-h-48 overflow-y-auto">
        {parts.map((part, partIdx) => {
          const lines = part.value.split('\n').filter((l, i, arr) =>
            // 去掉末尾空行（diffLines 尾部通常带一个空串）
            !(i === arr.length - 1 && l === '')
          );
          return lines.map((line, lineIdx) => (
            <div
              key={`${partIdx}-${lineIdx}`}
              className={
                part.added
                  ? 'bg-[#0e2a1a] text-[#4ade80] px-3 py-0.5 flex items-start gap-2'
                  : part.removed
                  ? 'bg-[#2a0e0e] text-[#f87171] px-3 py-0.5 flex items-start gap-2'
                  : 'text-[#7a9bb8] px-3 py-0.5 flex items-start gap-2'
              }
            >
              <span className="select-none w-3 flex-shrink-0">
                {part.added ? '+' : part.removed ? '-' : ' '}
              </span>
              <pre className="whitespace-pre-wrap break-all">{line || ' '}</pre>
            </div>
          ));
        })}
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-[#1e2d42]">
        <button
          onClick={onCancel}
          className="text-xs px-3 py-1 rounded border border-[#2a3f5a] text-[#7a9bb8] hover:text-[#c8daea] hover:border-[#7a9bb8] transition-colors"
        >
          取消
        </button>
        <button
          onClick={onApply}
          className="text-xs px-3 py-1 rounded bg-[#00c9a7] text-white hover:bg-[#00a98f] transition-colors flex items-center gap-1"
        >
          <Check size={12} />
          应用
        </button>
      </div>
    </div>
  );
};
