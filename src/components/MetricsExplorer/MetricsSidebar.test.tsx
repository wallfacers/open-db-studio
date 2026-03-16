import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared state for capturing MetricsTree props across tests
const capturedMetricsTreeProps: { current: any } = { current: null };

// Shared mock init function reference — replaced per test
const mockInitHolder: { fn: ReturnType<typeof vi.fn> } = { fn: vi.fn() };

// Mock MetricsTree to capture props for inspection in tests
vi.mock('./MetricsTree', () => ({
  MetricsTree: (props: any) => {
    capturedMetricsTreeProps.current = props;
    return React.createElement('div', { 'data-testid': 'metrics-tree' }, 'MetricsTree');
  },
}));

// Mock Tauri and stores
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue([]) }));
vi.mock('../../store/metricsTreeStore', () => ({
  useMetricsTreeStore: () => ({ init: mockInitHolder.fn }),
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
    capturedMetricsTreeProps.current = null;
    mockInitHolder.fn = vi.fn();
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

  it('点击刷新按钮调用 init()', async () => {
    const mockInit = vi.fn();
    mockInitHolder.fn = mockInit;

    const { MetricsSidebar } = await import('./MetricsSidebar');
    await act(async () => {
      const root = createRoot(container);
      root.render(React.createElement(MetricsSidebar, { sidebarWidth: 240, onResize: () => {} }));
    });

    // Find the RefreshCw SVG element — it is inside a Tooltip wrapper and has an onClick handler
    // The lucide-react RefreshCw renders an <svg> element; its parent div has the onClick
    const svgElements = container.querySelectorAll('svg');
    // RefreshCw is the refresh icon — find by clicking each svg and checking calls
    let refreshSvg: Element | null = null;
    svgElements.forEach(svg => {
      if (svg.getAttribute('onClick') !== null || svg.parentElement) {
        // The RefreshCw SVG itself has the onClick attached to it
        refreshSvg = svg;
      }
    });

    // Click all SVGs — only the RefreshCw onClick calls init()
    await act(async () => {
      svgElements.forEach(svg => {
        svg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    });

    expect(mockInit).toHaveBeenCalled();
  });

  it('resize 手柄触发 onResize 回调', async () => {
    const handleResize = vi.fn();

    const { MetricsSidebar } = await import('./MetricsSidebar');
    await act(async () => {
      const root = createRoot(container);
      root.render(React.createElement(MetricsSidebar, { sidebarWidth: 240, onResize: handleResize }));
    });

    // The resize handle has class "cursor-col-resize" and onMouseDown={onResize}
    const resizeHandle = container.querySelector('.cursor-col-resize') as HTMLElement;
    expect(resizeHandle).toBeTruthy();

    await act(async () => {
      resizeHandle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(handleResize).toHaveBeenCalledTimes(1);
  });

  it('MetricsTree 收到 onOpenMetricTab 和 onOpenMetricListTab', async () => {
    const { MetricsSidebar } = await import('./MetricsSidebar');
    await act(async () => {
      const root = createRoot(container);
      root.render(React.createElement(MetricsSidebar, { sidebarWidth: 240, onResize: () => {} }));
    });

    // capturedMetricsTreeProps.current is set by the MetricsTree mock when rendered
    expect(capturedMetricsTreeProps.current).not.toBeNull();
    expect(typeof capturedMetricsTreeProps.current.onOpenMetricTab).toBe('function');
    expect(typeof capturedMetricsTreeProps.current.onOpenMetricListTab).toBe('function');
  });
});
