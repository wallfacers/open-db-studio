import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

// Mock @tanstack/react-virtual
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(),
}));

// 构造一个最小化的 mock Virtualizer
function makeMockVirtualizer(count: number) {
  const items = Array.from({ length: count }, (_, i) => ({
    key: i,
    index: i,
    start: i * 28,
    size: 28,
    lane: 0,
    end: i * 28 + 28,
  }));
  return {
    getVirtualItems: () => items,
    getTotalSize: () => count * 28,
    measureElement: vi.fn(),
  } as any;
}

describe('VirtualTable', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('渲染 thead 内容', async () => {
    const { VirtualTable } = await import('./VirtualTable');
    const virt = makeMockVirtualizer(3);
    await act(async () => {
      createRoot(container).render(
        React.createElement(VirtualTable, {
          columns: ['id', 'name'],
          colWidths: [100, 150],
          rowVirtualizer: virt,
          thead: React.createElement('tr', null,
            React.createElement('th', null, 'ID'),
            React.createElement('th', null, 'Name'),
          ),
          renderRow: (ri) => React.createElement('td', { key: ri }, `row-${ri}`),
        })
      );
    });
    expect(container.textContent).toContain('ID');
    expect(container.textContent).toContain('Name');
  });

  it('只渲染虚拟行数量的 tr', async () => {
    const { VirtualTable } = await import('./VirtualTable');
    const virt = makeMockVirtualizer(3);
    await act(async () => {
      createRoot(container).render(
        React.createElement(VirtualTable, {
          columns: ['id'],
          colWidths: [100],
          rowVirtualizer: virt,
          thead: React.createElement('tr', null),
          renderRow: (ri) => React.createElement('td', null, `row-${ri}`),
        })
      );
    });
    // 只应有 3 行（mock 返回 3 个虚拟行）
    expect(container.querySelectorAll('tbody tr').length).toBe(3);
  });

  it('tbody 高度等于 getTotalSize()', async () => {
    const { VirtualTable } = await import('./VirtualTable');
    const virt = makeMockVirtualizer(5);
    await act(async () => {
      createRoot(container).render(
        React.createElement(VirtualTable, {
          columns: ['id'],
          colWidths: [100],
          rowVirtualizer: virt,
          thead: React.createElement('tr', null),
          renderRow: (ri) => React.createElement('td', null, `r${ri}`),
        })
      );
    });
    const tbody = container.querySelector('tbody') as HTMLElement;
    expect(tbody.style.height).toBe('140px'); // 5 * 28 = 140
  });
});
