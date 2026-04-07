import { describe, it, expect } from 'vitest'
import { patchError, execError } from '../errors'

describe('patchError', () => {
  it('returns error status with problem only', () => {
    const result = patchError('Something broke')
    expect(result).toEqual({ status: 'error', message: 'Something broke' })
  })

  it('appends expected when provided', () => {
    const result = patchError('Bad path', '/tables/[id=<n>]/<field>')
    expect(result.message).toBe('Bad path. Expected: /tables/[id=<n>]/<field>')
  })

  it('appends hint when provided', () => {
    const result = patchError('Cannot add relation via patch', 'use ui_exec', 'ui_read(mode="actions") shows all actions')
    expect(result.message).toBe(
      'Cannot add relation via patch. Expected: use ui_exec. Hint: ui_read(mode="actions") shows all actions'
    )
  })
})

describe('execError', () => {
  it('returns success false with problem only', () => {
    const result = execError('Unknown action')
    expect(result).toEqual({ success: false, error: 'Unknown action' })
  })

  it('appends hint when provided', () => {
    const result = execError('Missing params', 'Schema: {...}')
    expect(result.error).toBe('Missing params. Hint: Schema: {...}')
  })
})
