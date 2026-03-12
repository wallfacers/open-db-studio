import { describe, it, expect } from 'vitest';
import { parseStatements, findStatementAtOffset } from './sqlParser';

describe('parseStatements', () => {
  it('单条语句（无分号）', () => {
    const result = parseStatements('SELECT 1');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('SELECT 1');
    expect(result[0].startOffset).toBe(0);
    expect(result[0].endOffset).toBe(8);
  });

  it('两条语句（分号分隔）', () => {
    const sql = 'SELECT 1;\nSELECT 2';
    const result = parseStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('SELECT 1');
    expect(result[1].text).toBe('SELECT 2');
    expect(result[1].startOffset).toBe(10);
  });

  it('忽略空语句（双分号）', () => {
    const result = parseStatements('SELECT 1;;SELECT 2');
    expect(result).toHaveLength(2);
  });

  it('单引号字符串内的分号不分割', () => {
    const sql = "SELECT ';' FROM t";
    const result = parseStatements(sql);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("SELECT ';' FROM t");
  });

  it('双引号字符串内的分号不分割', () => {
    const sql = 'SELECT ";" FROM t';
    const result = parseStatements(sql);
    expect(result).toHaveLength(1);
  });

  it('SQL标准双引号转义（双单引号）内的分号不分割', () => {
    const sql = "SELECT 'it''s a test; here' FROM t";
    const result = parseStatements(sql);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("SELECT 'it''s a test; here' FROM t");
  });

  it('单行语句 startLine 和 endLine 均为 0', () => {
    const result = parseStatements('SELECT 1');
    expect(result).toHaveLength(1);
    expect(result[0].startLine).toBe(0);
    expect(result[0].endLine).toBe(0);
  });

  it('两条语句换行分隔时各自的 startLine 和 endLine 正确', () => {
    const sql = 'SELECT 1;\nSELECT 2';
    const result = parseStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0].startLine).toBe(0);
    expect(result[0].endLine).toBe(0);
    expect(result[1].startLine).toBe(1);
    expect(result[1].endLine).toBe(1);
  });

  it('多行语句的 startLine 为 0、endLine 为尾行号', () => {
    const sql = 'SELECT\n  1\nFROM t';
    const result = parseStatements(sql);
    expect(result).toHaveLength(1);
    expect(result[0].startLine).toBe(0);
    expect(result[0].endLine).toBe(2);
  });
});

describe('findStatementAtOffset', () => {
  it('光标在第一条语句中', () => {
    const sql = 'SELECT 1;\nSELECT 2';
    const stmts = parseStatements(sql);
    expect(findStatementAtOffset(stmts, 3)?.text).toBe('SELECT 1');
  });

  it('光标在第二条语句中', () => {
    const sql = 'SELECT 1;\nSELECT 2';
    const stmts = parseStatements(sql);
    expect(findStatementAtOffset(stmts, 15)?.text).toBe('SELECT 2');
  });

  it('光标在分号上返回前一条语句', () => {
    const sql = 'SELECT 1;\nSELECT 2';
    const stmts = parseStatements(sql);
    expect(findStatementAtOffset(stmts, 8)?.text).toBe('SELECT 1');
  });

  it('只有一条语句时始终返回该语句', () => {
    const stmts = parseStatements('SELECT 1');
    expect(findStatementAtOffset(stmts, 99)?.text).toBe('SELECT 1');
  });

  it('空语句数组返回 null', () => {
    expect(findStatementAtOffset([], 0)).toBeNull();
  });

  it('光标恰好在第二条语句起始位置', () => {
    const sql = 'SELECT 1;\nSELECT 2';
    const stmts = parseStatements(sql);
    // offset 10 = start of 'SELECT 2'
    expect(findStatementAtOffset(stmts, 10)?.text).toBe('SELECT 2');
  });
});
