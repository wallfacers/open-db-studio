import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
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
 * - Auto 模式：直接写入 SQL + 触发 Banner + mcp_diff_respond(true)
 * - 非 Auto 模式：调用 proposeSqlDiff 展示 DiffPanel
 * - 任意模式下 original 未找到：mcp_diff_respond(false)（防止 Rust 侧永久阻塞）
 *
 * 需在 App.tsx 根组件中调用，确保全局唯一且生命周期与应用一致。
 * autoApplyTimerRef 依赖本 hook 的全局唯一生命周期。
 */
export function useToolBridge() {
  const autoApplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<DiffProposalPayload>('sql-diff-proposal', (event) => {
      const { original, modified, reason } = event.payload;
      const { sqlContent, proposeSqlDiff, setSql, setAutoApplyBanner } = useQueryStore.getState();
      const { autoMode, setAssistantOpen } = useAppStore.getState();

      const normalizeStmt = (s: string) => s.trim().replace(/;+$/, '');
      const originalNorm = normalizeStmt(original);

      // 全量扫描所有 Tab，找到第一个包含 original 文本的 Tab
      for (const [tabId, full] of Object.entries(sqlContent)) {
        const stmts = parseStatements(full);
        const match = stmts.find(s => normalizeStmt(s.text) === originalNorm);
        if (!match) continue;

        if (autoMode) {
          // ── Auto 模式：直接应用，不显示 DiffPanel ──
          // 分号消费：避免 modified 自带分号时产生双分号
          const endOffset = full[match.endOffset] === ';' ? match.endOffset + 1 : match.endOffset;
          const newSql = full.slice(0, match.startOffset) + modified + full.slice(endOffset);

          setSql(tabId, newSql);

          // 触发 Banner（清除旧定时器，防止快速连续触发时旧定时器残留）
          if (autoApplyTimerRef.current) clearTimeout(autoApplyTimerRef.current);
          setAutoApplyBanner({ reason });
          autoApplyTimerRef.current = setTimeout(() => {
            setAutoApplyBanner(null);
            autoApplyTimerRef.current = null;
          }, 1500);

          invoke('mcp_diff_respond', { confirmed: true }).catch(() => {});
          setAssistantOpen(true);
        } else {
          // ── 普通模式：展示 DiffPanel 等待用户确认 ──
          proposeSqlDiff({
            original,
            modified,
            reason,
            tabId,
            startOffset: match.startOffset,
            endOffset: match.endOffset,
          });
          setAssistantOpen(true);
        }
        return;
      }

      // original 在任何 Tab 中均未找到：通知 Rust 失败，防止 oneshot channel 永久阻塞
      console.warn(
        '[useToolBridge] propose_sql_diff: original not found in any tab.',
        'original:', original.slice(0, 80)
      );
      invoke('mcp_diff_respond', { confirmed: false }).catch(() => {});
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
      // 清理定时器，防止组件卸载后写入 store
      if (autoApplyTimerRef.current) clearTimeout(autoApplyTimerRef.current);
    };
  }, []); // 仅挂载一次，无依赖
}
