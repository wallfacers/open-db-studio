import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench, Check, AlertCircle } from 'lucide-react';
import type { ToolUsePart, ToolResultPart } from '../../types';

interface ToolCallCardProps {
  toolUse: ToolUsePart;
  toolResult?: ToolResultPart;
}

export const ToolCallCard: React.FC<ToolCallCardProps> = ({ toolUse, toolResult }) => {
  const [expanded, setExpanded] = useState(false);

  const hasResult = !!toolResult;
  const isError = toolResult?.isError;

  return (
    <div className="my-1.5 rounded border border-border-default overflow-hidden">
      {/* 标题栏 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-background-elevated hover:bg-background-hover transition-colors text-left"
      >
        <Wrench size={11} className="text-foreground-muted flex-shrink-0" />
        <span className="text-[11px] font-medium text-foreground-default truncate flex-1">
          {toolUse.name}
        </span>
        {hasResult && (
          isError ? (
            <AlertCircle size={10} className="text-error flex-shrink-0" />
          ) : (
            <Check size={10} className="text-accent flex-shrink-0" />
          )
        )}
        {expanded ? (
          <ChevronDown size={10} className="text-foreground-ghost flex-shrink-0" />
        ) : (
          <ChevronRight size={10} className="text-foreground-ghost flex-shrink-0" />
        )}
      </button>

      {/* 展开内容 */}
      {expanded && (
        <div className="border-t border-border-default">
          {/* 参数 */}
          {toolUse.arguments && (
            <div className="px-2.5 py-1.5 bg-background-base">
              <div className="text-[10px] text-foreground-ghost mb-0.5">Arguments</div>
              <pre className="text-[10px] text-foreground-muted font-mono whitespace-pre-wrap break-all max-h-32 overflow-auto">
                {tryFormatJson(toolUse.arguments)}
              </pre>
            </div>
          )}
          {/* 结果 */}
          {toolResult && (
            <div className={`px-2.5 py-1.5 border-t border-border-default ${isError ? 'bg-error-subtle' : 'bg-background-base'}`}>
              <div className="text-[10px] text-foreground-ghost mb-0.5">Result</div>
              <pre className={`text-[10px] font-mono whitespace-pre-wrap break-all max-h-32 overflow-auto ${
                isError ? 'text-error' : 'text-foreground-muted'
              }`}>
                {toolResult.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function tryFormatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}
