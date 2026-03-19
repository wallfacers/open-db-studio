import { describe, it, expect } from 'vitest';
import { parseAliases } from './graphUtils';

describe('parseAliases', () => {
  it('解析逗号分隔字符串', () => {
    expect(parseAliases('orders, 订单, order_table')).toEqual(['orders', '订单', 'order_table']);
  });

  it('解析 JSON 数组格式', () => {
    expect(parseAliases('["revenue", "销售额"]')).toEqual(['revenue', '销售额']);
  });

  it('空字符串返回空数组', () => {
    expect(parseAliases('')).toEqual([]);
  });

  it('仅含空格/逗号返回空数组', () => {
    expect(parseAliases(',  , ')).toEqual([]);
  });

  it('中文逗号分隔', () => {
    const result = parseAliases('收入，revenue，营收');
    expect(result).toContain('收入');
    expect(result).toContain('revenue');
    expect(result).toContain('营收');
  });

  it('单个词不拆分', () => {
    expect(parseAliases('orders')).toEqual(['orders']);
  });

  it('JSON 数组过滤空元素', () => {
    expect(parseAliases('["a", "", "b"]')).toEqual(['a', 'b']);
  });

  it('前后空白不影响结果', () => {
    expect(parseAliases('  orders  ')).toEqual(['orders']);
  });

  it('混合中英文逗号分隔', () => {
    const result = parseAliases('users,用户，user_table');
    expect(result).toContain('users');
    expect(result).toContain('用户');
    expect(result).toContain('user_table');
  });

  it('JSON 语法错误时回退到逗号分隔', () => {
    // 非合法 JSON，应当回退到逗号分隔
    const result = parseAliases('[broken, json');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });
});
