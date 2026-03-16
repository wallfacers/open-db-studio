/**
 * applyDiff 替换逻辑测试
 *
 * 复现 queryStore.applyDiff 中的核心替换逻辑：
 *   - endOffset 指向语句末尾（不含分号）
 *   - 若原文在 endOffset 处紧跟 ';'，则一并消费，避免 modified 自带分号时出现双分号
 */
import { describe, it, expect } from 'vitest';
import { parseStatements } from './sqlParser';

/** 与 queryStore.applyDiff 行为完全一致的纯函数，方便单元测试 */
function applyDiff(full: string, startOffset: number, endOffset: number, modified: string): string {
  const adjustedEnd = full[endOffset] === ';' ? endOffset + 1 : endOffset;
  return full.slice(0, startOffset) + modified + full.slice(adjustedEnd);
}

/** 模拟 useToolBridge 中的语句匹配（去末尾分号后比较） */
function normalizeStmt(s: string) {
  return s.trim().replace(/;+$/, '');
}

/** 完整流程：从原始 SQL + original/modified 文本，返回应用后的新 SQL */
function simulateProposeDiff(
  full: string,
  originalFromAi: string,
  modifiedFromAi: string
): string | null {
  const stmts = parseStatements(full);
  const match = stmts.find(s => normalizeStmt(s.text) === normalizeStmt(originalFromAi));
  if (!match) return null;
  return applyDiff(full, match.startOffset, match.endOffset, modifiedFromAi);
}

// ─────────────────────────────────────────────────────────────────────────────
// 核心场景：selec → select
// ─────────────────────────────────────────────────────────────────────────────
describe('applyDiff — selec * from account 修复场景', () => {
  it('单条语句带一个分号：替换后保持一个分号', () => {
    const full = 'selec * from account;';
    const result = simulateProposeDiff(full, 'selec * from account;', 'select * from account;');
    expect(result).toBe('select * from account;');
  });

  it('AI original 不带分号，modified 带分号：替换后保持一个分号', () => {
    const full = 'selec * from account;';
    const result = simulateProposeDiff(full, 'selec * from account', 'select * from account;');
    expect(result).toBe('select * from account;');
  });

  it('原文带三个分号 ;;;：只消费紧跟语句的第一个分号，其余保留', () => {
    const full = 'selec * from account;;;';
    const result = simulateProposeDiff(full, 'selec * from account;', 'select * from account;');
    expect(result).toBe('select * from account;;;');
  });

  it('原文无分号：modified 带分号会追加分号', () => {
    const full = 'selec * from account';
    const result = simulateProposeDiff(full, 'selec * from account', 'select * from account;');
    expect(result).toBe('select * from account;');
  });

  it('原文无分号、modified 也无分号：结果无分号', () => {
    const full = 'selec * from account';
    const result = simulateProposeDiff(full, 'selec * from account', 'select * from account');
    expect(result).toBe('select * from account');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 多语句场景
// ─────────────────────────────────────────────────────────────────────────────
describe('applyDiff — 多语句场景', () => {
  it('修复第一条语句，第二条保持不变', () => {
    const full = 'selec * from account;\nSELECT 1;';
    const result = simulateProposeDiff(full, 'selec * from account;', 'select * from account;');
    expect(result).toBe('select * from account;\nSELECT 1;');
  });

  it('修复第二条语句，第一条保持不变', () => {
    const full = 'SELECT 1;\nselec * from account;';
    const result = simulateProposeDiff(full, 'selec * from account;', 'select * from account;');
    expect(result).toBe('SELECT 1;\nselect * from account;');
  });

  it('original 在 AI 侧带分号、编辑器中间有多余空格：匹配失败返回 null', () => {
    // AI 传入的 original 与编辑器内容不同（额外空格），无法匹配
    const full = 'selec  * from account;'; // 两个空格
    const result = simulateProposeDiff(full, 'selec * from account;', 'select * from account;');
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyDiff 纯函数边界测试
// ─────────────────────────────────────────────────────────────────────────────
describe('applyDiff — 纯函数边界', () => {
  it('endOffset 后不是分号时不额外消费', () => {
    // full = "abc def"，替换 "abc" -> "xyz"，endOffset=3，full[3]=' '
    const result = applyDiff('abc def', 0, 3, 'xyz');
    expect(result).toBe('xyz def');
  });

  it('endOffset 后是分号时消费该分号', () => {
    // full = "abc;def"，替换 "abc" -> "xyz;"，endOffset=3，full[3]=';'
    const result = applyDiff('abc;def', 0, 3, 'xyz;');
    expect(result).toBe('xyz;def');
  });

  it('替换发生在中间，前后内容正确保留', () => {
    const full = 'SELECT 1;\nselec * from t;\nSELECT 3;';
    const stmts = parseStatements(full);
    const match = stmts.find(s => s.text === 'selec * from t')!;
    const result = applyDiff(full, match.startOffset, match.endOffset, 'select * from t;');
    expect(result).toBe('SELECT 1;\nselect * from t;\nSELECT 3;');
  });
});
