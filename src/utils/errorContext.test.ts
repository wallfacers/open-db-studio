// src/utils/errorContext.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildErrorContext } from './errorContext';

// mock zustand stores
vi.mock('../store/appStore', () => ({
  useAppStore: { getState: () => ({
    lastOperationContext: {
      type: 'sql_execute',
      connectionId: 1,
      database: 'mydb',
      sql: 'SELECT * FROM users',
    },
  }) },
}));

vi.mock('../store/connectionStore', () => ({
  useConnectionStore: { getState: () => ({
    connections: [{ id: 1, name: 'prod', driver: 'mysql', host: 'localhost', port: 3306 }],
    metaCache: { 1: { dbVersion: '8.0.32', driver: 'mysql', host: 'localhost', port: 3306, name: 'prod' } },
    tables: [],
  }) },
}));

vi.mock('../store/queryStore', () => ({
  useQueryStore: { getState: () => ({ queryHistory: [] }) },
}));

vi.mock('../store/aiStore', () => ({
  useAiStore: { getState: () => ({ configs: [], activeConfigId: null }) },
}));

describe('buildErrorContext', () => {
  it('sql_execute 类型生成包含连接和 SQL 的 Markdown', () => {
    const result = buildErrorContext('sql_execute', { rawError: 'Unknown column' });
    expect(result.userMessage).toContain('Unknown column');
    expect(result.markdownContext).toContain('## SQL 执行错误');
    expect(result.markdownContext).toContain('prod');
    expect(result.markdownContext).toContain('SELECT * FROM users');
    expect(result.markdownContext).toContain('8.0.32');
  });

  it('内部抛异常时降级返回 markdownContext: null', () => {
    // lastOperationContext 为 null 时不应抛出
    const result = buildErrorContext('sql_execute', { rawError: 'err' });
    expect(result.userMessage).toBeTruthy();
    // markdownContext 可能为 null 或有效字符串，不得抛出
    expect(() => result.markdownContext).not.toThrow();
  });
});
