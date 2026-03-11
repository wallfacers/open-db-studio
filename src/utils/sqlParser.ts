import type { SqlStatementInfo } from '../types';

/**
 * 解析 SQL 字符串为多条语句，带起止偏移量。
 * 处理单引号和双引号内的分号（不作为分隔符）。
 *
 * 已知限制：
 * - 行注释（--）和块注释（/* *\/）内的分号仍会分割（与现有 queryStore 一致）
 * - SQL 标准双引号转义（''）不处理，反斜杠转义（\'）同样简单处理
 */
export function parseStatements(sql: string): SqlStatementInfo[] {
  const results: SqlStatementInfo[] = [];
  let start = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const prev = sql[i - 1] ?? '';

    if (ch === "'" && !inDoubleQuote && prev !== '\\') {
      inSingleQuote = !inSingleQuote;
    } else if (ch === '"' && !inSingleQuote && prev !== '\\') {
      inDoubleQuote = !inDoubleQuote;
    } else if (ch === ';' && !inSingleQuote && !inDoubleQuote) {
      pushStatement(sql, start, i, results);
      start = i + 1;
    }
  }

  // 末尾无分号的最后一条语句
  pushStatement(sql, start, sql.length, results);

  return results;
}

function pushStatement(
  sql: string,
  rawStart: number,
  rawEnd: number,
  results: SqlStatementInfo[]
): void {
  const slice = sql.slice(rawStart, rawEnd);
  const trimmedStart = rawStart + (slice.length - slice.trimStart().length);
  const text = slice.trim();
  if (text.length > 0) {
    results.push({ text, startOffset: trimmedStart, endOffset: trimmedStart + text.length });
  }
}

/**
 * 找到光标位置所在的语句。
 * 光标在分号上时，返回分号前的语句。
 * 如果 offset 超出所有语句范围，返回最后一条。
 */
export function findStatementAtOffset(
  statements: SqlStatementInfo[],
  offset: number
): SqlStatementInfo | null {
  if (statements.length === 0) return null;
  // 从后往前，返回 startOffset <= offset 的最后一条
  for (let i = statements.length - 1; i >= 0; i--) {
    if (statements[i].startOffset <= offset) return statements[i];
  }
  return statements[0];
}
