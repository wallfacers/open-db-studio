import { describe, it, expect } from 'vitest'
import { parsePath, matchPathPattern } from '../pathResolver'

describe('parsePath', () => {
  it('parses simple field path', () => {
    expect(parsePath('/content')).toEqual([
      { field: 'content' },
    ])
  })

  it('parses ERCanvas style: /tables/[id=5]/name', () => {
    expect(parsePath('/tables/[id=5]/name')).toEqual([
      { field: 'tables', filters: { id: '5' } },
      { field: 'name' },
    ])
  })

  it('parses ERCanvas style with name: /tables/[name=users]/comment', () => {
    expect(parsePath('/tables/[name=users]/comment')).toEqual([
      { field: 'tables', filters: { name: 'users' } },
      { field: 'comment' },
    ])
  })

  it('parses TableForm style: /columns[name=email]/dataType', () => {
    expect(parsePath('/columns[name=email]/dataType')).toEqual([
      { field: 'columns', filters: { name: 'email' } },
      { field: 'dataType' },
    ])
  })

  it('parses array append: /tables/[id=5]/columns/-', () => {
    expect(parsePath('/tables/[id=5]/columns/-')).toEqual([
      { field: 'tables', filters: { id: '5' } },
      { field: 'columns', isAppend: true },
    ])
  })

  it('parses remove with context: /columns/[id=10]/[tableId=5]', () => {
    expect(parsePath('/columns/[id=10]/[tableId=5]')).toEqual([
      { field: 'columns', filters: { id: '10' } },
      { field: '', filters: { tableId: '5' } },
    ])
  })

  it('parses nested field: /tables/[id=5]/position/x', () => {
    expect(parsePath('/tables/[id=5]/position/x')).toEqual([
      { field: 'tables', filters: { id: '5' } },
      { field: 'position' },
      { field: 'x' },
    ])
  })

  it('parses standalone filter: /relations/[id=7]', () => {
    expect(parsePath('/relations/[id=7]')).toEqual([
      { field: 'relations', filters: { id: '7' } },
    ])
  })
})

describe('matchPathPattern', () => {
  it('matches simple field', () => {
    expect(matchPathPattern('/content', '/content')).toBe(true)
  })

  it('matches ERCanvas table field', () => {
    expect(matchPathPattern('/tables/[id=5]/name', '/tables/[<key>=<val>]/<field>')).toBe(true)
  })

  it('matches ERCanvas table field with name addressing', () => {
    expect(matchPathPattern('/tables/[name=users]/comment', '/tables/[<key>=<val>]/<field>')).toBe(true)
  })

  it('matches array append', () => {
    expect(matchPathPattern('/tables/[id=5]/columns/-', '/tables/[<key>=<val>]/columns/-')).toBe(true)
  })

  it('matches remove with context', () => {
    expect(matchPathPattern('/columns/[id=10]/[tableId=5]', '/columns/[id=<n>]/[tableId=<n>]')).toBe(true)
  })

  it('matches relation remove', () => {
    expect(matchPathPattern('/relations/[id=7]', '/relations/[id=<n>]')).toBe(true)
  })

  it('rejects mismatched paths', () => {
    expect(matchPathPattern('/relations/[id=7]', '/tables/[id=<n>]/<field>')).toBe(false)
  })

  it('matches nested position field', () => {
    expect(matchPathPattern('/tables/[id=5]/position/x', '/tables/[<key>=<val>]/<field>')).toBe(true)
  })
})
