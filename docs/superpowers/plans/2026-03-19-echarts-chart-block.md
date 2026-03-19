# ECharts Chart Block Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 AI 助手回答中支持 ` ```chart ` 代码块，内联渲染与项目主题色一致的 ECharts 交互式图表。

**Architecture:** 在 `MarkdownContent.tsx` 的 `code` 组件中增加 `language === 'chart'` 分支，将 JSON 解析后传入新建的 `ChartBlock.tsx` 组件，使用 `echarts-for-react` 渲染并注册 `ods-dark` 自定义主题与项目色系对齐。

**Tech Stack:** React 18, TypeScript, echarts@^5.6.0, echarts-for-react@^3.0.2, vitest, @testing-library/react

---

## File Map

| 操作 | 路径 | 职责 |
|------|------|------|
| 新增 | `src/components/shared/ChartBlock.tsx` | 主题注册 + JSON 解析 + ECharts 渲染 + 错误降级 |
| 新增 | `src/components/shared/ChartBlock.test.tsx` | ChartBlock 单元测试 |
| 修改 | `src/components/shared/MarkdownContent.tsx` | 添加 `language==='chart'` 分支（3行） |
| 修改 | `src-tauri/skills/echarts-ai-skill/SKILL.md` | 追加 open-db-studio 集成输出规则 |

---

## Chunk 1: 安装依赖 + 创建 ChartBlock 组件

### Task 1: 安装 echarts 依赖

**Files:**
- Modify: `package.json`（npm 自动更新）

- [ ] **Step 1: 安装依赖**

```bash
cd D:/project/java/source/open-db-studio
npm install echarts@^5.6.0 echarts-for-react@^3.0.2
```

预期输出：`added 2 packages`，无 peer dependency 警告。

- [ ] **Step 2: 验证安装**

```bash
node -e "require('./node_modules/echarts/package.json')" && echo "OK"
node -e "require('./node_modules/echarts-for-react/package.json')" && echo "OK"
```

预期：两行均输出 `OK`。

- [ ] **Step 3: 提交**

```bash
git add package.json package-lock.json
git commit -m "chore: install echarts@^5.6.0 echarts-for-react@^3.0.2"
```

---

### Task 2: 创建 ChartBlock.tsx

**Files:**
- Create: `src/components/shared/ChartBlock.tsx`

- [ ] **Step 1: 创建组件文件**

新建 `src/components/shared/ChartBlock.tsx`，完整内容如下：

```tsx
import React, { useState, useCallback, useMemo, memo } from 'react';
import ReactECharts from 'echarts-for-react';
// 重要：必须从 'echarts/core' 导入，与测试中 vi.mock('echarts/core') 路径一致
// 不要改成 import * as echarts from 'echarts'（全包路径）
import * as echarts from 'echarts/core';
import { Copy, Check, AlertTriangle } from 'lucide-react';

// ── ODS 暗色主题（与项目色系一致）────────────────────────────────────────────
const COLOR_PALETTE = [
  '#00c9a7', // 品牌青绿（主系列）
  '#4a9eca', // 天蓝
  '#7b8ff0', // 蓝紫
  '#e07b54', // 暖橙
  '#f0c94a', // 琥珀黄
  '#a78bfa', // 柔紫
  '#34d399', // 翠绿
  '#f87171', // 玫红
];

const ODS_CHART_THEME = {
  color: COLOR_PALETTE,
  backgroundColor: '#0d1117',
  textStyle: {
    color: '#c8daea',
    fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
    fontSize: 12,
  },
  title: {
    textStyle: { color: '#c8daea', fontSize: 13, fontWeight: 'normal' },
    subtextStyle: { color: '#7a9bb8', fontSize: 11 },
  },
  legend: {
    textStyle: { color: '#7a9bb8' },
    inactiveColor: '#2a3f5a',
    pageTextStyle: { color: '#7a9bb8' },
  },
  tooltip: {
    backgroundColor: '#151d28',
    borderColor: '#2a3f5a',
    borderWidth: 1,
    textStyle: { color: '#c8daea', fontSize: 12 },
    extraCssText: 'box-shadow: 0 4px 12px rgba(0,0,0,0.5);',
  },
  axisPointer: {
    lineStyle: { color: '#2a3f5a' },
    crossStyle: { color: '#2a3f5a' },
    label: { backgroundColor: '#151d28', borderColor: '#2a3f5a', color: '#c8daea' },
  },
  categoryAxis: {
    axisLine:  { lineStyle: { color: '#1e2d42' } },
    axisTick:  { lineStyle: { color: '#1e2d42' } },
    axisLabel: { color: '#7a9bb8', fontSize: 11 },
    splitLine: { lineStyle: { color: '#1e2d42', type: 'dashed' } },
    splitArea: { areaStyle: { color: ['rgba(30,45,66,0.15)', 'rgba(30,45,66,0.05)'] } },
  },
  valueAxis: {
    axisLine:  { lineStyle: { color: '#1e2d42' } },
    axisTick:  { lineStyle: { color: '#1e2d42' } },
    axisLabel: { color: '#7a9bb8', fontSize: 11 },
    splitLine: { lineStyle: { color: '#1e2d42', type: 'dashed' } },
    splitArea: { areaStyle: { color: ['rgba(30,45,66,0.15)', 'rgba(30,45,66,0.05)'] } },
  },
  logAxis: {
    axisLine:  { lineStyle: { color: '#1e2d42' } },
    axisTick:  { lineStyle: { color: '#1e2d42' } },
    axisLabel: { color: '#7a9bb8', fontSize: 11 },
    splitLine: { lineStyle: { color: '#1e2d42', type: 'dashed' } },
  },
  timeAxis: {
    axisLine:  { lineStyle: { color: '#1e2d42' } },
    axisTick:  { lineStyle: { color: '#1e2d42' } },
    axisLabel: { color: '#7a9bb8', fontSize: 11 },
    splitLine: { lineStyle: { color: '#1e2d42', type: 'dashed' } },
  },
  line: {
    symbol: 'circle',
    symbolSize: 5,
    smooth: false,
    lineStyle: { width: 2 },
    emphasis: { lineStyle: { width: 3 } },
  },
  bar: {
    barMaxWidth: 48,
    itemStyle: { borderRadius: [2, 2, 0, 0] },
    emphasis: { itemStyle: { opacity: 0.85 } },
  },
  pie: {
    radius: ['0%', '65%'],
    label: { color: '#c8daea', fontSize: 11 },
    labelLine: { lineStyle: { color: '#2a3f5a' } },
    emphasis: { label: { color: '#e8f4fd', fontWeight: 'bold' } },
  },
  scatter: {
    symbolSize: 8,
    emphasis: { symbolSize: 12 },
  },
  candlestick: {
    itemStyle: {
      color: '#00c9a7',
      color0: '#f87171',
      borderColor: '#00c9a7',
      borderColor0: '#f87171',
    },
  },
  radar: {
    name: { textStyle: { color: '#7a9bb8' } },
    axisLine: { lineStyle: { color: '#1e2d42' } },
    splitLine: { lineStyle: { color: '#1e2d42', type: 'dashed' } },
    splitArea: { areaStyle: { color: ['rgba(30,45,66,0.2)', 'rgba(30,45,66,0.05)'] } },
  },
  dataZoom: {
    backgroundColor: '#111922',
    dataBackground: {
      lineStyle: { color: '#2a3f5a' },
      areaStyle: { color: 'rgba(42,63,90,0.3)' },
    },
    fillerColor: 'rgba(0,201,167,0.12)',
    handleStyle: { color: '#00c9a7', borderColor: '#009e84' },
    textStyle: { color: '#7a9bb8' },
  },
  visualMap: {
    color: ['#00c9a7', '#4a9eca', '#151d28'],
    textStyle: { color: '#7a9bb8' },
  },
  toolbox: {
    iconStyle: { borderColor: '#2a3f5a' },
    emphasis: { iconStyle: { borderColor: '#00c9a7' } },
  },
  timeline: {
    lineStyle: { color: '#2a3f5a' },
    itemStyle: { color: '#00c9a7' },
    label: { color: '#7a9bb8' },
    controlStyle: { color: '#7a9bb8', borderColor: '#2a3f5a' },
  },
};

// 模块加载时注册一次，之后所有 ReactECharts theme="ods-dark" 均使用此主题
echarts.registerTheme('ods-dark', ODS_CHART_THEME);

// ── ErrorBoundary（捕获 ECharts 渲染异常，降级为文字提示）────────────────────
interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback: React.ReactNode;
}
class ChartErrorBoundary extends React.Component<ErrorBoundaryProps, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

// ── ChartBlock ────────────────────────────────────────────────────────────────
// 重要约定：此组件只负责渲染，不持有外部 state；所有状态均在组件内部管理。
export const ChartBlock: React.FC<{ code: string }> = memo(({ code }) => {
  const [copied, setCopied] = useState(false);

  const { option, error } = useMemo(() => {
    try {
      return { option: JSON.parse(code) as Record<string, unknown>, error: null };
    } catch (e) {
      return { option: null, error: (e as Error).message };
    }
  }, [code]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  // 从 series[0].type 推断图表类型标签
  const chartType = (
    (option?.series as Array<{ type?: string }>)?.[0]?.type ?? 'chart'
  );

  // 背景色始终强制覆盖，其余字段尊重 AI 输出
  const mergedOption = option
    ? { backgroundColor: '#0d1117', ...option }
    : null;

  // ── 错误状态 ──
  if (error) {
    return (
      <div data-testid="chart-error" className="my-2 rounded overflow-hidden border border-red-800/40">
        <div className="flex items-center gap-2 px-3 py-2 bg-red-900/20 border-b border-red-800/40">
          <AlertTriangle size={13} className="text-red-400 flex-shrink-0" />
          <span className="text-xs text-red-400">图表数据格式有误</span>
        </div>
        <pre className="bg-[#0d1117] text-[#f87171] text-xs p-3 overflow-x-auto font-mono whitespace-pre-wrap">
          {code}
        </pre>
      </div>
    );
  }

  // ── 正常渲染 ──
  return (
    <div data-testid="chart-block" className="my-2 rounded overflow-hidden border border-[#1e2d42]">
      {/* 工具栏（与 CodeBlock 风格一致） */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#161b22] border-b border-[#1e2d42]">
        <span className="text-xs text-[#7a9bb8] font-mono">{chartType}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-xs text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
        >
          {copied ? (
            <><Check size={12} className="text-[#00c9a7]" /><span className="text-[#00c9a7]">已复制</span></>
          ) : (
            <><Copy size={12} /><span>复制</span></>
          )}
        </button>
      </div>

      {/* ECharts 渲染区，ErrorBoundary 捕获渲染异常 */}
      <ChartErrorBoundary
        fallback={
          <div className="bg-[#0d1117] text-[#7a9bb8] text-xs p-4 text-center">
            图表渲染失败
          </div>
        }
      >
        <ReactECharts
          option={mergedOption!}
          theme="ods-dark"
          style={{ height: 280 }}
          notMerge={true}
          opts={{ renderer: 'canvas' }}
        />
      </ChartErrorBoundary>
    </div>
  );
});
```

- [ ] **Step 2: TypeScript 类型检查**

```bash
cd D:/project/java/source/open-db-studio
npx tsc --noEmit
```

预期：无报错。如果出现 `echarts-for-react` 类型报错，运行：
```bash
npm install --save-dev @types/echarts
```
（注：echarts 5.x 自带类型定义，通常不需要此步骤）

---

### Task 3: 编写 ChartBlock 单元测试

**Files:**
- Create: `src/components/shared/ChartBlock.test.tsx`

- [ ] **Step 1: 写测试文件**

新建 `src/components/shared/ChartBlock.test.tsx`：

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// jsdom 中 navigator.clipboard 默认为 undefined，必须手动挂载
// 注意：此赋值在模块顶层执行，在所有测试用例之前生效
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

describe('ChartBlock', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
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
      createRoot(container).render(React.createElement(ChartBlock, { code: validOption }));
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
      createRoot(container).render(React.createElement(ChartBlock, { code: option }));
    });

    // 工具栏应显示 "line"
    expect(container.textContent).toContain('line');
  });

  it('无 series 时类型标签显示 "chart"', async () => {
    const { ChartBlock } = await import('./ChartBlock');
    const option = JSON.stringify({ title: { text: '空系列' } });

    await act(async () => {
      createRoot(container).render(React.createElement(ChartBlock, { code: option }));
    });

    expect(container.textContent).toContain('chart');
  });

  it('无效 JSON 显示错误 banner', async () => {
    const { ChartBlock } = await import('./ChartBlock');

    await act(async () => {
      createRoot(container).render(
        React.createElement(ChartBlock, { code: '{ invalid json' })
      );
    });

    expect(container.querySelector('[data-testid="chart-error"]')).toBeTruthy();
    expect(container.textContent).toContain('图表数据格式有误');
    // 原始内容应原样显示
    expect(container.textContent).toContain('{ invalid json');
  });

  it('错误状态不渲染 ECharts 组件', async () => {
    const { ChartBlock } = await import('./ChartBlock');

    await act(async () => {
      createRoot(container).render(
        React.createElement(ChartBlock, { code: 'not json at all' })
      );
    });

    expect(container.querySelector('[data-testid="echarts-mock"]')).toBeNull();
  });

  it('点击复制按钮调用 clipboard.writeText', async () => {
    const { ChartBlock } = await import('./ChartBlock');
    const code = JSON.stringify({ series: [{ type: 'pie', data: [] }] });

    await act(async () => {
      createRoot(container).render(React.createElement(ChartBlock, { code }));
    });

    const copyBtn = container.querySelector('button') as HTMLButtonElement;
    await act(async () => { copyBtn.click(); });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code);
  });
});
```

- [ ] **Step 2: 运行测试，确认全部通过**

```bash
cd D:/project/java/source/open-db-studio
npm test -- ChartBlock
```

预期输出：
```
✓ 有效 JSON 渲染图表容器
✓ 从 series[0].type 推断图表类型标签
✓ 无 series 时类型标签显示 "chart"
✓ 无效 JSON 显示错误 banner
✓ 错误状态不渲染 ECharts 组件
✓ 点击复制按钮调用 clipboard.writeText

Test Files  1 passed (1)
Tests       6 passed (6)
```

- [ ] **Step 3: 提交**

```bash
git add src/components/shared/ChartBlock.tsx src/components/shared/ChartBlock.test.tsx
git commit -m "feat(chart): 新增 ChartBlock 组件，注册 ods-dark ECharts 主题"
```

---

## Chunk 2: 集成到 MarkdownContent + 更新 SKILL.md

### Task 4: 修改 MarkdownContent.tsx

**Files:**
- Modify: `src/components/shared/MarkdownContent.tsx:1,52-54`

- [ ] **Step 1: 添加 import**

在 `src/components/shared/MarkdownContent.tsx` 第 7 行（现有 import 块末尾）追加：

```tsx
import { ChartBlock } from './ChartBlock';
```

- [ ] **Step 2: 添加 chart 分支**

在 `mdComponents.code` 函数中，找到以下现有代码（约第 52 行）：

```tsx
    if (match) {
      return <CodeBlock language={language} code={String(children).replace(/\n$/, '')} />;
    }
```

替换为：

```tsx
    if (match) {
      if (language === 'chart') {
        return <ChartBlock code={String(children).replace(/\n$/, '')} />;
      }
      return <CodeBlock language={language} code={String(children).replace(/\n$/, '')} />;
    }
```

- [ ] **Step 3: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

预期：无报错。

- [ ] **Step 4: 运行全量测试，确认无回归**

```bash
npm test
```

预期：所有测试通过，无新失败。

- [ ] **Step 5: 提交**

```bash
git add src/components/shared/MarkdownContent.tsx
git commit -m "feat(chart): MarkdownContent 支持 chart 代码块分发至 ChartBlock"
```

---

### Task 5: 更新 SKILL.md 集成规则

**Files:**
- Modify: `src-tauri/skills/echarts-ai-skill/SKILL.md`（末尾追加）

- [ ] **Step 1: 追加集成规则**

在 `src-tauri/skills/echarts-ai-skill/SKILL.md` 文件末尾追加以下内容：

```markdown

## open-db-studio 集成输出规则

在 open-db-studio 中使用此 skill 时，将最终 ECharts option 输出为 `chart` 代码块：

```chart
{
  "title": { "text": "图表标题" },
  "xAxis": { "type": "category", "data": ["A", "B", "C"] },
  "yAxis": { "type": "value" },
  "series": [{ "type": "bar", "data": [120, 200, 150] }]
}
```

**规则：**
- 必须使用 ` ```chart ` 标记，不得使用 ` ```json ` 或 ` ```javascript `
- 内容必须是合法 JSON（双引号字符串，无尾随逗号，无注释）
- `series` 数组必须存在且至少包含一个元素，`type` 字段必填
- 图表标题、坐标轴标签等文字使用用户的实际数据，不要使用占位符
- 调色板由主题自动提供，无需在 option 中手动指定 `color` 字段

**支持的图表类型（series[0].type）：**
`line` | `bar` | `pie` | `scatter` | `radar` | `funnel` | `gauge` | `heatmap` | `treemap` | `candlestick` | `boxplot` | `sankey` | `graph`
```

- [ ] **Step 2: 验证文件末尾内容正确**

```bash
tail -20 src-tauri/skills/echarts-ai-skill/SKILL.md
```

预期：显示刚追加的集成规则内容。

- [ ] **Step 3: 提交**

```bash
git add src-tauri/skills/echarts-ai-skill/SKILL.md
git commit -m "docs(skill): echarts-ai-skill 追加 open-db-studio 集成输出规则"
```

---

### Task 6: 端到端冒烟验证

- [ ] **Step 1: 启动开发服务**

```bash
npm run dev
```

- [ ] **Step 2: 手动验证**

在 AI 助手输入框中发送：

> 帮我用图表展示这个数据：1月100，2月150，3月200，4月180

观察 AI 是否输出 ` ```chart ` 代码块，且 AI 回答区域渲染出柱状图（深色背景、青绿色系列柱）。

- [ ] **Step 3: 验证错误降级**

手动在聊天中构造一条带有 ` ```chart ` 但内容为无效 JSON 的消息：

```
```chart
{ invalid
```
```

预期：显示红色 banner `图表数据格式有误`，不崩溃。

- [ ] **Step 4: 最终全量测试**

```bash
npm test
```

预期：全部通过。

- [ ] **Step 5: 最终提交**

```bash
git add -A
git commit -m "feat(chart): ECharts chart block 完整实现（ods-dark 主题 + chart 标记渲染）"
```
