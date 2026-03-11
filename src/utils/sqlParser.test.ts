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
});
