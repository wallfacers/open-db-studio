import { describe, it, expect } from 'vitest'
import { applyPatch } from '../jsonPatch'

describe('applyPatch - RFC 6902', () => {
  const base = {
    tableName: 'users',
    columns: [
      { name: 'id', dataType: 'INT' },
      { name: 'email', dataType: 'VARCHAR' },
    ],
  }

  it('replace scalar', () => {
    const result = applyPatch(base, [
      { op: 'replace', path: '/tableName', value: 'orders' },
    ])
    expect(result.tableName).toBe('orders')
  })

  it('add to array end', () => {
    const result = applyPatch(base, [
      { op: 'add', path: '/columns/-', value: { name: 'age', dataType: 'INT' } },
    ])
    expect(result.columns).toHaveLength(3)
    expect(result.columns[2].name).toBe('age')
  })

  it('add at array index', () => {
    const result = applyPatch(base, [
      { op: 'add', path: '/columns/1', value: { name: 'name', dataType: 'VARCHAR' } },
    ])
    expect(result.columns).toHaveLength(3)
    expect(result.columns[1].name).toBe('name')
    expect(result.columns[2].name).toBe('email')
  })

  it('remove from array', () => {
    const result = applyPatch(base, [
      { op: 'remove', path: '/columns/0' },
    ])
    expect(result.columns).toHaveLength(1)
    expect(result.columns[0].name).toBe('email')
  })

  it('replace nested field', () => {
    const result = applyPatch(base, [
      { op: 'replace', path: '/columns/0/dataType', value: 'BIGINT' },
    ])
    expect(result.columns[0].dataType).toBe('BIGINT')
  })

  it('move array element', () => {
    const result = applyPatch(base, [
      { op: 'move', from: '/columns/0', path: '/columns/1' },
    ])
    expect(result.columns[0].name).toBe('email')
    expect(result.columns[1].name).toBe('id')
  })

  it('copy field', () => {
    const result = applyPatch(base, [
      { op: 'copy', from: '/tableName', path: '/comment' },
    ])
    expect((result as any).comment).toBe('users')
  })

  it('atomic: rolls back all on error', () => {
    expect(() =>
      applyPatch(base, [
        { op: 'replace', path: '/tableName', value: 'orders' },
        { op: 'replace', path: '/nonexistent/deep/path', value: 'fail' },
      ])
    ).toThrow()
    expect(base.tableName).toBe('users')
  })

  it('does not mutate original', () => {
    const original = structuredClone(base)
    applyPatch(base, [
      { op: 'replace', path: '/tableName', value: 'changed' },
    ])
    expect(base).toEqual(original)
  })
})

describe('applyPatch - [key=value] addressing', () => {
  const base = {
    columns: [
      { name: 'id', dataType: 'INT' },
      { name: 'email', dataType: 'VARCHAR' },
      { name: 'amount', dataType: 'DECIMAL' },
    ],
  }

  it('replace by name', () => {
    const result = applyPatch(base, [
      { op: 'replace', path: '/columns[name=amount]/dataType', value: 'BIGINT' },
    ])
    expect(result.columns[2].dataType).toBe('BIGINT')
  })

  it('remove by name', () => {
    const result = applyPatch(base, [
      { op: 'remove', path: '/columns[name=email]' },
    ])
    expect(result.columns).toHaveLength(2)
    expect(result.columns.every((c: any) => c.name !== 'email')).toBe(true)
  })

  it('throws on name not found', () => {
    expect(() =>
      applyPatch(base, [
        { op: 'replace', path: '/columns[name=nonexistent]/dataType', value: 'X' },
      ])
    ).toThrow()
  })
})

describe('applyPatch - test op (RFC 6902)', () => {
  const base = {
    tableName: 'users',
    columns: [
      { name: 'id', dataType: 'INT' },
      { name: 'email', dataType: 'VARCHAR' },
    ],
  }

  it('test passes when value matches', () => {
    const result = applyPatch(base, [
      { op: 'test', path: '/tableName', value: 'users' },
      { op: 'replace', path: '/tableName', value: 'orders' },
    ])
    expect(result.tableName).toBe('orders')
  })

  it('test fails when value differs — atomic rollback', () => {
    expect(() =>
      applyPatch(base, [
        { op: 'test', path: '/tableName', value: 'wrong_name' },
        { op: 'replace', path: '/tableName', value: 'orders' },
      ])
    ).toThrow(/Test failed/)
    expect(base.tableName).toBe('users')
  })

  it('test works with nested objects', () => {
    const result = applyPatch(base, [
      { op: 'test', path: '/columns/0', value: { name: 'id', dataType: 'INT' } },
      { op: 'replace', path: '/columns/0/dataType', value: 'BIGINT' },
    ])
    expect(result.columns[0].dataType).toBe('BIGINT')
  })

  it('test works with [name=xxx] addressing', () => {
    const result = applyPatch(base, [
      { op: 'test', path: '/columns[name=email]/dataType', value: 'VARCHAR' },
      { op: 'replace', path: '/columns[name=email]/dataType', value: 'TEXT' },
    ])
    expect(result.columns[1].dataType).toBe('TEXT')
  })
})
