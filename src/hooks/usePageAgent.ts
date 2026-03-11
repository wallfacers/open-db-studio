import { useEffect, useRef } from 'react';
import { PageAgent, tool } from 'page-agent';
import * as z from 'zod';
import { useAiStore } from '../store/aiStore';
import { useToolBridge } from './useToolBridge';

/**
 * 初始化 Page Agent 并注册 Tool Bridge 工具。
 *
 * Page Agent 负责：
 * 1. DOM 感知（自动分析页面结构）
 * 2. 自然语言 → 意图识别 → 调用注册的 Tool
 *
 * Tool Bridge 工具：
 * - get_current_sql：获取编辑器状态（含消歧信息）
 * - propose_sql_diff：提出修改方案（展示 diff）
 * - list_tabs：列出所有 Tab
 * - switch_tab：切换 Tab
 *
 * 安全：interactiveBlacklist 排除密码/API Key 字段。
 */
export function usePageAgent() {
  const { configs, activeConfigId } = useAiStore();
  const toolBridge = useToolBridge();
  const agentRef = useRef<PageAgent | null>(null);

  // 切换模型配置时重置，以便 effect 重新初始化
  useEffect(() => { agentRef.current = null; }, [activeConfigId]);

  useEffect(() => {
    // 已初始化则跳过（避免重复创建）
    if (agentRef.current) return;

    const activeConfig =
      configs.find(c => c.id === activeConfigId) ??
      configs.find(c => c.is_default) ??
      configs[0];

    // 无 LLM 配置时静默跳过（用户未配置模型）
    if (!activeConfig) return;

    const agent = new PageAgent({
      // LLM 配置（复用现有 LLM 设置，支持所有 OpenAI 兼容接口）
      baseURL: activeConfig.base_url,
      apiKey:  activeConfig.api_key,
      model:   activeConfig.model,

      // 知识库：告知 AI 这是一个数据库 IDE
      instructions: {
        system: [
          '你是一个数据库 IDE 助手，运行在 open-db-studio 桌面应用中。',
          '修改 SQL 时，必须先调用 get_current_sql 获取当前内容，再调用 propose_sql_diff 展示修改方案，不得直接写入编辑器。',
          '所有修改必须通过 propose_sql_diff，等待用户确认后才生效。',
          '严禁读取、显示或操作密码、API Key 等安全敏感字段。',
        ].join('\n'),
      },

      // 安全边界：排除密码和 API Key 相关输入（使用工厂函数匹配当前 DOM 元素）
      interactiveBlacklist: [
        () => document.querySelector('[type="password"]') as Element,
        () => document.querySelector('.api-key-field') as Element,
        () => document.querySelector('[data-sensitive="true"]') as Element,
      ].filter(fn => fn() !== null) as (() => Element)[],

      // 自定义工具：Tool Bridge
      customTools: {
        get_current_sql: tool({
          description: '获取当前 SQL 编辑器的内容、光标位置、选中文本和已解析的语句列表。在修改 SQL 前必须先调用此工具以确定要修改的语句。',
          inputSchema: z.object({}),
          execute: async function() {
            return JSON.stringify(toolBridge.getCurrentSql());
          },
        }),

        propose_sql_diff: tool({
          description: '提出 SQL 修改方案。展示 diff 对比（原始 vs 修改后），等待用户点击"应用"确认。original 必须与 get_current_sql 返回的某条 statements 文本完全一致。',
          inputSchema: z.object({
            original: z.string().describe('要修改的原始 SQL 语句（必须与 statements 中的文本完全一致）'),
            modified: z.string().describe('修改后的 SQL 语句'),
            reason:   z.string().describe('修改原因的简短说明（中文，一句话）'),
          }),
          execute: async function({ original, modified, reason }) {
            const result = toolBridge.proposeSqlDiff(original, modified, reason);
            return JSON.stringify(result);
          },
        }),

        list_tabs: tool({
          description: '列出所有打开的查询 Tab，返回 id、title、type 列表。',
          inputSchema: z.object({}),
          execute: async function() {
            return JSON.stringify(toolBridge.listTabs());
          },
        }),

        switch_tab: tool({
          description: '切换到指定的查询 Tab。',
          inputSchema: z.object({
            tabId: z.string().describe('目标 Tab 的 id（从 list_tabs 获取）'),
          }),
          execute: async function({ tabId }) {
            return JSON.stringify(toolBridge.switchTab(tabId));
          },
        }),
      },
    });

    agentRef.current = agent;
  // 注意：toolBridge 每次渲染重建，但 agentRef 的 early-return 保证只初始化一次。
  // 若 activeConfigId 变更（用户切换模型），通过重置 agentRef.current = null 触发重建。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConfigId]);

  return agentRef.current;
}
