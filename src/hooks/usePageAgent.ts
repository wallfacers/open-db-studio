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

  // Fix 2: toolBridgeRef 保持 toolBridge 最新引用，避免 execute 回调中产生陈旧闭包
  const toolBridgeRef = useRef(toolBridge);
  useEffect(() => { toolBridgeRef.current = toolBridge; }, [toolBridge]);

  // Fix 1: 合并两个 effect 为一个，依赖 [configs, activeConfigId]
  // 在 effect 开始时重置 agentRef，避免首次加载时 configs 异步到达导致的静默失败
  useEffect(() => {
    // 切换模型配置或 configs 更新时重置，以便重新初始化
    agentRef.current = null;

    const activeConfig =
      configs.find(c => c.id === activeConfigId) ??
      configs.find(c => c.is_default) ??
      configs[0];

    // 无 LLM 配置时静默跳过（用户未配置模型）
    if (!activeConfig) return;

    const agent = new PageAgent({
      // LLM 配置（复用现有 LLM 设置，支持所有 OpenAI 兼容接口）
      baseURL: activeConfig.base_url,
      // Fix 5: api_key 在前端访问是经过审核的例外情况。
      // LLM 配置的 API Key 需要在前端直接传递给 PageAgent 发起 LLM 调用，
      // 这与连接凭证（connection passwords）不同——连接密码严格保存在 Rust 层，
      // 绝不暴露到前端。SECURITY.md 的限制仅针对连接凭证，不适用于 LLM API Key。
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

      // Fix 3: 移除 .filter(fn => fn() !== null)——该过滤器在初始化时执行工厂函数，
      // 若元素当时不在 DOM 中则会错误地剔除该工厂，破坏动态查询目的。
      // 安全边界：排除密码和 API Key 相关输入（使用工厂函数匹配当前 DOM 元素）
      interactiveBlacklist: [
        () => document.querySelector('[type="password"]') as Element,
        () => document.querySelector('.api-key-field') as Element,
        () => document.querySelector('[data-sensitive="true"]') as Element,
      ],

      // Fix 2: 所有 execute 回调通过 toolBridgeRef.current 访问最新 toolBridge，
      // 避免 PageAgent 构造时捕获的陈旧闭包导致调用失效。
      customTools: {
        get_current_sql: tool({
          description: '获取当前 SQL 编辑器的内容、光标位置、选中文本和已解析的语句列表。在修改 SQL 前必须先调用此工具以确定要修改的语句。',
          inputSchema: z.object({}),
          execute: async function() {
            return JSON.stringify(toolBridgeRef.current.getCurrentSql());
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
            const result = toolBridgeRef.current.proposeSqlDiff(original, modified, reason);
            return JSON.stringify(result);
          },
        }),

        list_tabs: tool({
          description: '列出所有打开的查询 Tab，返回 id、title、type 列表。',
          inputSchema: z.object({}),
          execute: async function() {
            return JSON.stringify(toolBridgeRef.current.listTabs());
          },
        }),

        switch_tab: tool({
          description: '切换到指定的查询 Tab。',
          inputSchema: z.object({
            tabId: z.string().describe('目标 Tab 的 id（从 list_tabs 获取）'),
          }),
          execute: async function({ tabId }) {
            return JSON.stringify(toolBridgeRef.current.switchTab(tabId));
          },
        }),
      },
    });

    agentRef.current = agent;

    // Fix 4: 清理函数——销毁 PageAgent 实例并重置 ref，防止内存泄漏
    return () => {
      (agentRef.current as PageAgent & { destroy?: () => void })?.destroy?.();
      agentRef.current = null;
    };
  }, [configs, activeConfigId]);

  return agentRef.current;
}
