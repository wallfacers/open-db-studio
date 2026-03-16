import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useQueryStore } from '../store/queryStore';
import { useAppStore } from '../store/appStore';
import { parseStatements } from '../utils/sqlParser';

interface DiffProposalPayload {
  original: string;
  modified: string;
  reason: string;
}

/**
 * 挂载全局 Tauri 事件监听器：
 * - 监听 'sql-diff-proposal' 事件（由 MCP server propose_sql_diff 工具触发）
 * - 在所有打开的 Tab 中查找 original 文本，解析 offset
 * - 调用 queryStore.proposeSqlDiff 展示 DiffPanel
 *
 * 需在 App.tsx 根组件中调用，确保全局唯一且生命周期与应用一致。
 */
export function useToolBridge() {
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<DiffProposalPayload>('sql-diff-proposal', (event) => {
      const { original, modified, reason } = event.payload;
      const { sqlContent, proposeSqlDiff } = useQueryStore.getState();

      // 全量扫描所有 Tab，找到第一个包含 original 文本的 Tab
      // （queryStore.activeTabId 为静态初始值，不可靠，故遍历所有条目）
      // 规范化：去除首尾空白和末尾分号，以便与 parseStatements 返回的 text 对比
      const normalizeStmt = (s: string) => s.trim().replace(/;+$/, '');
      const originalNorm = normalizeStmt(original);
      for (const [tabId, full] of Object.entries(sqlContent)) {
        const stmts = parseStatements(full);
        const match = stmts.find(s => normalizeStmt(s.text) === originalNorm);
        if (match) {
          proposeSqlDiff({
            original,
            modified,
            reason,
            tabId,
            startOffset: match.startOffset,
            endOffset: match.endOffset,
          });
          // 自动打开 AI 助手面板，确保用户能看到 DiffPanel 确认界面
          useAppStore.getState().setAssistantOpen(true);
          return;
        }
      }

      console.warn(
        '[useToolBridge] propose_sql_diff: original not found in any tab.',
        'original:', original.slice(0, 80)
      );
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []); // 仅挂载一次，无依赖
}
