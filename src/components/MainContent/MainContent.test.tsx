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
vi.mock('../../store', async () => {
  const { useQueryStore } = await import('../../store/queryStore');
  return {
    useQueryStore,
    useConnectionStore: () => ({ activeConnectionId: null }),
    useAiStore: () => ({
      explainSql: vi.fn(),
      isExplaining: {},
      optimizeSql: vi.fn(),
      isOptimizing: {},
      cancelOptimizeSql: vi.fn(),
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
