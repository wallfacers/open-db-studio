import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface PermissionRule {
  id: string;
  /** glob 模式匹配工具名称，如 "read_*", "execute_sql", "*" */
  pattern: string;
  action: 'allow' | 'deny';
  /** session = 仅当前会话生效, global = 全局持久化 */
  scope: 'session' | 'global';
  createdAt: number;
}

interface PermissionRuleState {
  rules: PermissionRule[];
  addRule: (rule: Omit<PermissionRule, 'id' | 'createdAt'>) => void;
  removeRule: (id: string) => void;
  clearRules: () => void;
  /** 匹配规则：返回第一个匹配的规则，或 null */
  matchRule: (toolName: string) => PermissionRule | null;
}

/** 将 glob 模式转换为正则表达式 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

let counter = 0;

export const usePermissionRuleStore = create<PermissionRuleState>()(
  persist(
    (set, get) => ({
      rules: [],

      addRule: (rule) => {
        const id = `rule_${Date.now()}_${++counter}`;
        set((s) => ({
          rules: [...s.rules, { ...rule, id, createdAt: Date.now() }],
        }));
      },

      removeRule: (id) => {
        set((s) => ({
          rules: s.rules.filter((r) => r.id !== id),
        }));
      },

      clearRules: () => set({ rules: [] }),

      matchRule: (toolName) => {
        const { rules } = get();
        // 按创建时间倒序匹配（最新规则优先）
        for (let i = rules.length - 1; i >= 0; i--) {
          const rule = rules[i];
          try {
            if (globToRegex(rule.pattern).test(toolName)) {
              return rule;
            }
          } catch {
            // 无效 pattern，跳过
          }
        }
        return null;
      },
    }),
    {
      name: 'ods-permission-rules',
      partialize: (state) => ({
        // 仅持久化 global scope 的规则
        rules: state.rules.filter((r) => r.scope === 'global'),
      }),
    }
  )
);
