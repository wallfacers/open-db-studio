import type { SqlStatementInfo } from '../types';

/**
 * 解析 SQL 字符串为多条语句，带起止偏移量。
 * 处理单引号和双引号内的分号（不作为分隔符）。
 * 正确跳过行注释（--）和块注释（/* *\/）内的分号。
 * 支持 SQL 标准双引号转义（'' 或 ""）及反斜杠转义（\'）。
 * 过滤掉纯注释语句（不发送到后端执行）。
 */
export function parseStatements(sql: string): SqlStatementInfo[] {
  const results: SqlStatementInfo[] = [];
  let start = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const prev = sql[i - 1] ?? '';

    // 行注释 --：跳过到行尾（不在字符串内时）
    if (ch === '-' && sql[i + 1] === '-' && !inSingleQuote && !inDoubleQuote) {
      const newline = sql.indexOf('\n', i);
      i = newline === -1 ? sql.length - 1 : newline;
      continue;
    }

    // 块注释 /* */：跳过到 */（不在字符串内时）
    if (ch === '/' && sql[i + 1] === '*' && !inSingleQuote && !inDoubleQuote) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length - 1 : end + 1;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      // Check for SQL standard doubled-quote escape: '' inside a string
      if (inSingleQuote && sql[i + 1] === "'") {
        i++; // skip the escaped quote pair
      } else if (prev !== '\\') {
        inSingleQuote = !inSingleQuote;
      }
    } else if (ch === '"' && !inSingleQuote) {
      if (inDoubleQuote && sql[i + 1] === '"') {
        i++; // skip the escaped quote pair
      } else if (prev !== '\\') {
        inDoubleQuote = !inDoubleQuote;
      }
    } else if (ch === ';' && !inSingleQuote && !inDoubleQuote) {
      pushStatement(sql, start, i, results);
      start = i + 1;
    }
  }

  // 末尾无分号的最后一条语句
  pushStatement(sql, start, sql.length, results);

  return results;
}

function countNewlines(sql: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i++) {
    if (sql[i] === '\n') count++;
  }
  return count;
}

/** 去掉所有注释后是否还有实际 SQL 内容 */
function hasActualSql(text: string): boolean {
  let s = text;
  // 循环去掉开头的行注释和块注释
  while (true) {
    s = s.trimStart();
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      s = nl === -1 ? '' : s.slice(nl + 1);
    } else if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      s = end === -1 ? '' : s.slice(end + 2);
    } else {
      break;
    }
  }
  return s.trim().length > 0;
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
  if (text.length > 0 && hasActualSql(text)) {
    const startLine = countNewlines(sql, 0, trimmedStart);
    const endLine = countNewlines(sql, 0, trimmedStart + text.length);
    results.push({ text, startOffset: trimmedStart, endOffset: trimmedStart + text.length, startLine, endLine });
  }
}

/**
 * 找到光标位置所在的语句。
 * 光标在分号上时，返回分号前的语句。
 * 光标在语句间空白或末尾时，返回最近的语句。
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
