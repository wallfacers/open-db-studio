import { useMemo } from 'react';
import { useTreeStore } from '../store/treeStore';

export interface SchemaSuggestion {
  label: string;
  kind: 'table' | 'view' | 'column';
  detail?: string;
}

/**
 * SQL 关键字触发模式：在这些关键字之后触发表名补全
 */
const TABLE_TRIGGER_KEYWORDS = /(?:FROM|JOIN|INTO|UPDATE|TABLE|DELETE\s+FROM)\s+(\w*)$/i;

/**
 * 列名触发模式：在表名后加.触发列名补全（简化版）
 */
const COLUMN_TRIGGER = /(\w+)\.(\w*)$/;

/**
 * 从聊天输入中提取补全上下文
 */
function extractCompletionContext(text: string, cursorPos: number): {
  type: 'table' | 'column' | null;
  prefix: string;
  tableName?: string;
  triggerStart: number;
} {
  const textBeforeCursor = text.slice(0, cursorPos);

  // 检查列名触发: tableName.colPrefix
  const colMatch = COLUMN_TRIGGER.exec(textBeforeCursor);
  if (colMatch) {
    return {
      type: 'column',
      prefix: colMatch[2],
      tableName: colMatch[1],
      triggerStart: cursorPos - colMatch[2].length,
    };
  }

  // 检查表名触发: FROM tablePrefix
  const tableMatch = TABLE_TRIGGER_KEYWORDS.exec(textBeforeCursor);
  if (tableMatch) {
    return {
      type: 'table',
      prefix: tableMatch[1],
      triggerStart: cursorPos - tableMatch[1].length,
    };
  }

  return { type: null, prefix: '', triggerStart: cursorPos };
}

export function useSchemaCompletions(
  connectionId: number | null,
  inputText: string,
  cursorPosition: number,
): {
  suggestions: SchemaSuggestion[];
  triggerStart: number;
  isActive: boolean;
} {
  const nodes = useTreeStore((s) => s.nodes);

  return useMemo(() => {
    if (!connectionId || !inputText) {
      return { suggestions: [], triggerStart: cursorPosition, isActive: false };
    }

    const ctx = extractCompletionContext(inputText, cursorPosition);
    if (!ctx.type) {
      return { suggestions: [], triggerStart: cursorPosition, isActive: false };
    }

    const prefix = ctx.prefix.toLowerCase();
    const suggestions: SchemaSuggestion[] = [];

    if (ctx.type === 'table') {
      // 从 treeStore 中过滤当前连接的表和视图
      for (const node of nodes.values()) {
        if (node.meta.connectionId !== connectionId) continue;
        if (node.nodeType !== 'table' && node.nodeType !== 'view') continue;
        if (prefix && !node.label.toLowerCase().startsWith(prefix)) continue;
        suggestions.push({
          label: node.label,
          kind: node.nodeType as 'table' | 'view',
          detail: node.meta.schema ? `${node.meta.schema}` : node.meta.database,
        });
      }
    } else if (ctx.type === 'column' && ctx.tableName) {
      // 从 treeStore 中查找匹配表名的列节点
      const tableNameLower = ctx.tableName.toLowerCase();
      for (const node of nodes.values()) {
        if (node.meta.connectionId !== connectionId) continue;
        if (node.nodeType !== 'column') continue;
        // 检查列的父节点是否是目标表
        const parentNode = node.parentId ? nodes.get(node.parentId) : null;
        if (parentNode && parentNode.label.toLowerCase() === tableNameLower) {
          if (prefix && !node.label.toLowerCase().startsWith(prefix)) continue;
          suggestions.push({
            label: node.label,
            kind: 'column',
            detail: node.meta.objectName,
          });
        }
      }
    }

    // 排序：按字母顺序
    suggestions.sort((a, b) => a.label.localeCompare(b.label));

    return {
      suggestions: suggestions.slice(0, 20), // 限制返回数量
      triggerStart: ctx.triggerStart,
      isActive: suggestions.length > 0,
    };
  }, [connectionId, inputText, cursorPosition, nodes]);
}
