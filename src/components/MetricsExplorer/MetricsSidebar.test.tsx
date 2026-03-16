import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock MetricsTree to avoid heavy store dependencies
vi.mock('./MetricsTree', () => ({
  MetricsTree: ({ onOpenMetricTab, onOpenMetricListTab }: any) =>
    React.createElement('div', { 'data-testid': 'metrics-tree' }, 'MetricsTree'),
}));

// Mock Tauri and stores
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue([]) }));
vi.mock('../../store/metricsTreeStore', () => ({
  useMetricsTreeStore: () => ({ init: vi.fn() }),
}));
vi.mock('../../store/queryStore', () => ({
  useQueryStore: {
    getState: () => ({
      openMetricTab: vi.fn(),
      openMetricListTab: vi.fn(),
    }),
  },
}));
vi.mock('../common/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

describe('MetricsSidebar', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('渲染侧边栏标题和搜索框', async () => {
    const { MetricsSidebar } = await import('./MetricsSidebar');
    await act(async () => {
      const root = createRoot(container);
      root.render(React.createElement(MetricsSidebar, { sidebarWidth: 240, onResize: () => {} }));
    });
    // Should render a title/heading related to metrics
    expect(container.textContent).toContain('指标');
  });

  it('接受 sidebarWidth prop 控制宽度', async () => {
    const { MetricsSidebar } = await import('./MetricsSidebar');
    await act(async () => {
      const root = createRoot(container);
      root.render(React.createElement(MetricsSidebar, { sidebarWidth: 300, onResize: () => {} }));
    });
    // Width should be reflected in the component style or element
    const sidebar = container.firstChild as HTMLElement;
    expect(sidebar).toBeTruthy();
    expect((sidebar as HTMLElement).style.width).toBe('300px');
  });
});
