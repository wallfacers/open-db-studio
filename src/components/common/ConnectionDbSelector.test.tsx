import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { fireEvent } from '@testing-library/dom'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

// Mock DropdownSelect to a simple select element for testability
vi.mock('./DropdownSelect', () => ({
  DropdownSelect: ({ value, options, placeholder, onChange, className }: {
    value: string
    options: { value: string; label: string }[]
    placeholder?: string
    onChange: (v: string) => void
    className?: string
  }) => (
    <select
      data-testid="dropdown"
      data-placeholder={placeholder}
      className={className}
      value={value}
      onChange={e => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}))

// Mock connectionStore
vi.mock('../../store/connectionStore', () => ({
  useConnectionStore: () => ({
    connections: [
      { id: 1, name: 'conn-1' },
      { id: 2, name: 'conn-2' },
    ],
    loadConnections: vi.fn(),
  }),
}))

import { invoke } from '@tauri-apps/api/core'
import { ConnectionDbSelector } from './ConnectionDbSelector'

const mockInvoke = vi.mocked(invoke)

let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
})

function renderIntoDoc(element: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root!: ReturnType<typeof createRoot>
  act(() => { root = createRoot(container); root.render(element) })
  cleanup = () => {
    act(() => root.unmount())
    container.remove()
  }
  return { container }
}

async function flushAsync() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

describe('ConnectionDbSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue([])
  })

  it('renders connection options from store', () => {
    const { container } = renderIntoDoc(
      <ConnectionDbSelector
        connectionId={0}
        database=""
        onConnectionChange={() => {}}
        onDatabaseChange={() => {}}
      />,
    )
    const selects = container.querySelectorAll('select')
    expect(selects.length).toBe(2)
    const connOptions = selects[0].querySelectorAll('option[value]:not([value=""])')
    expect(connOptions.length).toBe(2)
    expect(connOptions[0].textContent).toBe('conn-1')
    expect(connOptions[1].textContent).toBe('conn-2')
  })

  it('calls list_databases_for_metrics when connectionId is set', async () => {
    mockInvoke.mockResolvedValue(['db1', 'db2'])
    const { container } = renderIntoDoc(
      <ConnectionDbSelector
        connectionId={1}
        database=""
        onConnectionChange={() => {}}
        onDatabaseChange={() => {}}
      />,
    )
    await flushAsync()
    expect(mockInvoke).toHaveBeenCalledWith('list_databases_for_metrics', { connectionId: 1 })
    const dbSelect = container.querySelectorAll('select')[1]
    const dbOptions = dbSelect.querySelectorAll('option[value]:not([value=""])')
    expect(dbOptions.length).toBe(2)
    expect(dbOptions[0].textContent).toBe('db1')
  })

  it('does not call list_databases_for_metrics when connectionId is 0', async () => {
    renderIntoDoc(
      <ConnectionDbSelector
        connectionId={0}
        database=""
        onConnectionChange={() => {}}
        onDatabaseChange={() => {}}
      />,
    )
    await flushAsync()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('calls onConnectionChange with numeric id when connection selected', () => {
    const onConnChange = vi.fn()
    const { container } = renderIntoDoc(
      <ConnectionDbSelector
        connectionId={0}
        database=""
        onConnectionChange={onConnChange}
        onDatabaseChange={() => {}}
      />,
    )
    const connSelect = container.querySelectorAll('select')[0] as HTMLSelectElement
    act(() => {
      fireEvent.change(connSelect, { target: { value: '2' } })
    })
    expect(onConnChange).toHaveBeenCalledWith(2)
  })

  it('shows error message when database load fails', async () => {
    mockInvoke.mockRejectedValue('连接超时')
    const { container } = renderIntoDoc(
      <ConnectionDbSelector
        connectionId={1}
        database=""
        direction="vertical"
        onConnectionChange={() => {}}
        onDatabaseChange={() => {}}
      />,
    )
    await flushAsync()
    expect(container.textContent).toContain('连接超时')
  })
})
