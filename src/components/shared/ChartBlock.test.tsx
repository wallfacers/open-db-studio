import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';


// echarts-for-react 依赖 canvas API，jsdom 环境中不可用，需要 mock
vi.mock('echarts-for-react', () => ({
  default: ({ option }: { option: Record<string, unknown> }) =>
    React.createElement('div', {
      'data-testid': 'echarts-mock',
      'data-type': (option?.series as Array<{ type?: string }>)?.[0]?.type ?? '',
    }),
}));

// ChartBlock.tsx 从 'echarts/core' 导入，mock 路径必须完全一致
vi.mock('echarts/core', () => ({
  registerTheme: vi.fn(),
}));

// lucide-react 在 jsdom 中可能有问题，mock 掉图标
vi.mock('lucide-react', () => ({
  Copy: () => React.createElement('span', { 'data-testid': 'icon-copy' }),
  Check: () => React.createElement('span', { 'data-testid': 'icon-check' }),
  AlertTriangle: () => React.createElement('span', { 'data-testid': 'icon-alert' }),
  Maximize2: () => React.createElement('span', { 'data-testid': 'icon-maximize2' }),
  X: () => React.createElement('span', { 'data-testid': 'icon-x' }),
}));

// react-i18next mock：返回 zh 翻译文本以保持测试语义
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'commonComponents.chartBlock.chartDataError': '图表数据格式有误',
        'commonComponents.chartBlock.copy': '复制',
        'commonComponents.chartBlock.copied': '已复制',
      };
      return translations[key] ?? key;
    },
  }),
}));

// jsdom 中 navigator.clipboard 默认为 undefined，必须手动挂载
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

// React 18 需要此标志才能在 act() 中正确冲刷 useLayoutEffect / useEffect
// 参见：https://reactjs.org/blog/2022/03/29/react-v18.html#configuring-your-testing-environment
// @ts-expect-error global IS_REACT_ACT_ENVIRONMENT
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 没有 ResizeObserver，ChartRenderer 的 useEffect 会抛 ReferenceError
// 导致 ChartErrorBoundary 捕获错误并渲染降级 UI；用 class 语法 mock（arrow fn 不能作为构造器）
vi.stubGlobal('ResizeObserver', class {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
});


describe('ChartBlock', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    document.body.removeChild(container);
  });

  it('有效 JSON 渲染图表容器', async () => {
    const { ChartBlock } = await import('./ChartBlock');
    const validOption = JSON.stringify({
      title: { text: '测试图表' },
      xAxis: { type: 'category', data: ['A', 'B', 'C'] },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', data: [1, 2, 3] }],
    });

    await act(async () => {
      root.render(React.createElement(ChartBlock, { code: validOption }));
    });

    expect(container.querySelector('[data-testid="chart-block"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="echarts-mock"]')).toBeTruthy();
  });

  it('从 series[0].type 推断图表类型标签', async () => {
    const { ChartBlock } = await import('./ChartBlock');
    const option = JSON.stringify({
      series: [{ type: 'line', data: [1, 2, 3] }],
    });

    await act(async () => {
      root.render(React.createElement(ChartBlock, { code: option }));
    });

    expect(container.textContent).toContain('line');
  });

  it('无 series 时类型标签显示 "chart"', async () => {
    const { ChartBlock } = await import('./ChartBlock');
    const option = JSON.stringify({ title: { text: '空系列' } });

    await act(async () => {
      root.render(React.createElement(ChartBlock, { code: option }));
    });

    expect(container.textContent).toContain('chart');
  });

  it('无效 JSON 显示错误 banner', async () => {
    const { ChartBlock } = await import('./ChartBlock');

    await act(async () => {
      root.render(
        React.createElement(ChartBlock, { code: '{ invalid json' })
      );
    });

    expect(container.querySelector('[data-testid="chart-error"]')).toBeTruthy();
    expect(container.textContent).toContain('图表数据格式有误');
    expect(container.textContent).toContain('{ invalid json');
  });

  it('错误状态不渲染 ECharts 组件', async () => {
    const { ChartBlock } = await import('./ChartBlock');

    await act(async () => {
      root.render(
        React.createElement(ChartBlock, { code: 'not json at all' })
      );
    });

    expect(container.querySelector('[data-testid="echarts-mock"]')).toBeNull();
  });

  it('点击复制按钮调用 clipboard.writeText', async () => {
    const { ChartBlock } = await import('./ChartBlock');
    const code = JSON.stringify({ series: [{ type: 'pie', data: [] }] });

    await act(async () => {
      root.render(React.createElement(ChartBlock, { code }));
    });

    // 工具栏有多个按钮，通过 icon-copy 定位复制按钮
    const copyBtn = container.querySelector('[data-testid="icon-copy"]')?.closest('button') as HTMLButtonElement;
    await act(async () => {
      copyBtn.click();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code);
  });

  it('点击复制后显示"已复制"文字', async () => {
    const { ChartBlock } = await import('./ChartBlock');
    const code = JSON.stringify({ series: [{ type: 'bar', data: [1] }] });

    await act(async () => {
      root.render(React.createElement(ChartBlock, { code }));
    });

    // 工具栏有多个按钮，通过 icon-copy 定位复制按钮
    const copyBtn = container.querySelector('[data-testid="icon-copy"]')?.closest('button') as HTMLButtonElement;
    await act(async () => { copyBtn.click(); });

    expect(container.textContent).toContain('已复制');
  });
});
