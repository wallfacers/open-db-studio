import { useCallback } from 'react';
import { useQueryStore } from '../store/queryStore';
import { parseStatements, findStatementAtOffset } from '../utils/sqlParser';
import type { SqlDiffProposal } from '../types';

/**
 * Tool Bridge — 暴露给 Page Agent 的结构化操作 API。
 *
 * 设计原则：
 * - Page Agent 不处理偏移量（内部实现细节）
 * - 所有 SQL 修改通过 propose→confirm→apply 流程
 * - getCurrentSql 返回完整上下文供 Page Agent 消歧
 */
export function useToolBridge() {
  const {
    sqlContent, activeTabId,
    editorInfo, setActiveTab,
    proposeSqlDiff, applyDiff, cancelDiff,
  } = useQueryStore();

  /**
   * 获取当前活动 Tab 的 SQL 上下文。
   * Page Agent 调用此工具感知编辑器状态，决定要修改哪条语句。
   */
  const getCurrentSql = useCallback(() => {
    const full = sqlContent[activeTabId] ?? '';
    const statements = parseStatements(full);
    const info = editorInfo[activeTabId];
    const cursorOffset = info?.cursorOffset ?? 0;
    const selectedText = info?.selectedText ?? null;
    const activeStatement = selectedText
      ? selectedText
      : findStatementAtOffset(statements, cursorOffset)?.text ?? null;

    return {
      full_content: full,
      selected_text: selectedText,
      cursor_position: cursorOffset,
      statements: statements.map(s => s.text),
      active_statement: activeStatement,
    };
  }, [sqlContent, activeTabId, editorInfo]);

  /**
   * 提出 SQL 修改方案（展示 diff，等待用户确认）。
   *
   * @param original - 要修改的原始语句文本（Page Agent 从 getCurrentSql 获得）
   * @param modified - 修改后的语句文本
   * @param reason   - 修改原因说明
   *
   * 内部解析：在当前编辑器内容中找到 original 文本，确定偏移区间。
   * 如果找不到匹配，返回 error。
   */
  const proposeSqlDiffTool = useCallback((
    original: string,
    modified: string,
    reason: string,
  ): { status: 'pending' | 'error'; message: string } => {
    const full = sqlContent[activeTabId] ?? '';
    const statements = parseStatements(full);

    // 优先：精确匹配 original 文本
    const matchedStmt = statements.find(s => s.text === original.trim());
    if (!matchedStmt) {
      return {
        status: 'error',
        message: `在当前编辑器中找不到文本：${original.slice(0, 50)}...`,
      };
    }

    const proposal: SqlDiffProposal = {
      original: matchedStmt.text,
      modified: modified.trim(),
      reason,
      tabId: activeTabId,
      startOffset: matchedStmt.startOffset,
      endOffset: matchedStmt.endOffset,
    };
    proposeSqlDiff(proposal);
    return { status: 'pending', message: '已展示 diff，等待用户确认' };
  }, [sqlContent, activeTabId, proposeSqlDiff]);

  /**
   * 切换活动 Tab。
   */
  const switchTab = useCallback((tabId: string): { status: string; message?: string } => {
    const exists = useQueryStore.getState().tabs.find(t => t.id === tabId);
    if (!exists) return { status: 'error', message: `Tab ${tabId} 不存在` };
    setActiveTab(tabId);
    return { status: 'ok' };
  }, [setActiveTab]);

  /**
   * 列出所有打开的 Tab。
   */
  const listTabs = useCallback(() => {
    return useQueryStore.getState().tabs.map(t => ({
      id: t.id, title: t.title, type: t.type,
    }));
  }, []);

  return {
    getCurrentSql,
    proposeSqlDiff: proposeSqlDiffTool,
    applySql: applyDiff,
    cancelSql: cancelDiff,
    switchTab,
    listTabs,
  };
}
