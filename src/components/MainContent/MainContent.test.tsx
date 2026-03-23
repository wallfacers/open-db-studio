import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useQueryStore } from '../../store/queryStore';

// Mock Tauri APIs
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue([]) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Mock heavy sub-components
vi.mock('./TableDataView', () => ({ TableDataView: () => React.createElement('div', null, 'TableDataView') }));
vi.mock('./TableStructureView', () => ({ TableStructureView: () => React.createElement('div', null, 'TableStructureView') }));
vi.mock('./CellEditorModal', () => ({ CellEditorModal: () => null }));
vi.mock('../ERDiagram', () => ({ default: () => React.createElement('div', null, 'ERDiagram') }));
vi.mock('../common/DropdownSelect', () => ({ DropdownSelect: () => null }));
vi.mock('../common/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../utils/errorContext', () => ({ buildErrorContext: vi.fn(() => ({ userMessage: 'error', markdownContext: null })) }));
vi.mock('../../utils/askAi', () => ({ askAiWithContext: vi.fn() }));
vi.mock('@monaco-editor/react', () => ({ default: () => React.createElement('div', null, 'MonacoEditor') }));
vi.mock('../../store/treeStore', () => ({ useTreeStore: () => ({ nodes: new Map() }) }));
vi.mock('../MetricsExplorer/MetricTab', () => ({
  MetricTab: () => React.createElement('div', { 'data-testid': 'metric-tab' }, 'MetricTab'),
}));
vi.mock('../MetricsExplorer/MetricListPanel', () => ({
  MetricListPanel: () => React.createElement('div', { 'data-testid': 'metric-list-panel' }, 'MetricListPanel'),
}));
vi.mock('../../store', async () => {
  const { useQueryStore } = await import('../../store/queryStore');
  return {
    useQueryStore,
    useConnectionStore: () => ({ activeConnectionId: null }),
    useAiStore: () => ({
      explainSql: vi.fn(),
      isExplaining: {},
      cancelExplainSql: vi.fn(),
    }),
  };
});
vi.mock('../../store/appStore', () => ({
  useAppStore: () => ({ setAssistantOpen: vi.fn() }),
}));
vi.mock('../shared/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('div', null, content),
}));

const defaultProps = {
  handleFormat: vi.fn(),
  showToast: vi.fn(),
  resultsHeight: 0,
  handleResultsResize: vi.fn(),
};

describe('MainContent', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    useQueryStore.setState({ tabs: [], activeTabId: '' });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('没有 tab 时渲染不崩溃（空状态）', async () => {
    const { MainContent } = await import('./index');
    await act(async () => {
      const root = createRoot(container);
      root.render(React.createElement(MainContent, defaultProps));
    });
    expect(container).toBeTruthy();
  });

  it('从 queryStore 读取 tabs 并渲染 tab 标题', async () => {
    useQueryStore.setState({
      tabs: [{ id: 't1', type: 'query', title: '查询1' }],
      activeTabId: 't1',
    });
    const { MainContent } = await import('./index');
    await act(async () => {
      const root = createRoot(container);
      root.render(React.createElement(MainContent, defaultProps));
    });
    expect(container.textContent).toContain('查询1');
  });
});

describe('metric tab rendering', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    useQueryStore.setState({ tabs: [], activeTabId: '' });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('metric tab 渲染 MetricTab 组件', async () => {
    useQueryStore.setState({
      tabs: [{ id: 'm1', type: 'metric', title: '销售额', metricId: 42 }],
      activeTabId: 'm1',
    });
    const { MainContent } = await import('./index');
    await act(async () => {
      const root = createRoot(container);
      root.render(React.createElement(MainContent, { ...defaultProps, showError: vi.fn() }));
    });
    expect(container.querySelector('[data-testid="metric-tab"]')).toBeTruthy();
  });

  it('metric_list tab 渲染 MetricListPanel 组件', async () => {
    useQueryStore.setState({
      tabs: [{ id: 'ml1', type: 'metric_list', title: 'Metrics', metricScope: { connectionId: 1 } }],
      activeTabId: 'ml1',
    });
    const { MainContent } = await import('./index');
    await act(async () => {
      const root = createRoot(container);
      root.render(React.createElement(MainContent, { ...defaultProps, showError: vi.fn() }));
    });
    expect(container.querySelector('[data-testid="metric-list-panel"]')).toBeTruthy();
  });
});

describe('SQL 结果集截断与分页', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('结果行数 <= 200 时不显示截断提示和翻页', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => [`${i}`]);
    useQueryStore.setState({
      tabs: [{ id: 'q1', type: 'query', title: 'Q1' }],
      activeTabId: 'q1',
      results: { q1: [{ kind: 'select', columns: ['id'], rows, row_count: 50, duration_ms: 1 }] },
    });
    const { MainContent } = await import('./index');
    await act(async () => {
      createRoot(container).render(React.createElement(MainContent, { ...defaultProps, resultsHeight: 300 }));
    });
    expect(container.textContent).not.toContain('显示前');
    expect(container.querySelector('[data-testid="result-pagination"]')).toBeNull();
  });

  it('结果行数 > 500 时显示截断提示', async () => {
    const rows = Array.from({ length: 600 }, (_, i) => [`${i}`]);
    useQueryStore.setState({
      tabs: [{ id: 'q2', type: 'query', title: 'Q2' }],
      activeTabId: 'q2',
      results: { q2: [{ kind: 'select', columns: ['id'], rows, row_count: 600, duration_ms: 1 }] },
    });
    const { MainContent } = await import('./index');
    await act(async () => {
      createRoot(container).render(React.createElement(MainContent, { ...defaultProps, resultsHeight: 300 }));
    });
    expect(container.textContent).toContain('600');
    expect(container.textContent).toContain('500');
  });

  it('结果行数 > 200 时显示翻页控件', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => [`${i}`]);
    useQueryStore.setState({
      tabs: [{ id: 'q3', type: 'query', title: 'Q3' }],
      activeTabId: 'q3',
      results: { q3: [{ kind: 'select', columns: ['id'], rows, row_count: 250, duration_ms: 1 }] },
    });
    const { MainContent } = await import('./index');
    await act(async () => {
      createRoot(container).render(React.createElement(MainContent, { ...defaultProps, resultsHeight: 300 }));
    });
    expect(container.querySelector('[data-testid="result-pagination"]')).not.toBeNull();
  });
});
