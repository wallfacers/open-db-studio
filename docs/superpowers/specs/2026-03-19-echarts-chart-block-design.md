# ECharts Chart Block 渲染设计

**日期：** 2026-03-19
**状态：** 已批准
**范围：** AI 助手回答页面内联图表渲染

---

## 问题陈述

AI 助手可以分析数据库查询结果并建议可视化方案，但目前只能输出文字描述或 JSON 代码块，无法在回答中直接渲染交互式图表。

---

## 目标

在 AI 助手回答中，支持通过特殊代码块标记（` ```chart ` ）内联渲染 ECharts 交互式图表，与现有 SQL 代码块的处理模式保持一致。

---

## 不在范围内

- 图表编辑功能
- 图表导出（PNG/SVG）
- 图表尺寸拖拽
- ChartRequest → option 的前端转换（MCP 或 CLI 路径）
- 新增 Tauri 命令或 MCP 工具

---

## 整体架构

```
AI 回答文本
    │
    ▼
MarkdownContent.tsx（ReactMarkdown）
    │
    ├─ language = "sql"   → CodeBlock（现有，语法高亮）
    ├─ language = "chart" → ChartBlock（新增，ECharts 渲染）
    └─ 其他语言           → CodeBlock（现有）

ChartBlock
    ├─ 解析 JSON（try/catch，失败降级为代码块）
    ├─ 渲染 <ReactECharts option={...} />
    └─ 顶部工具栏：图表类型标签 + 复制 JSON 按钮
```

**依赖变更：**

| 变更 | 说明 |
|------|------|
| `echarts` | ECharts 核心库 |
| `echarts-for-react` | React 封装组件 |
| 无 Rust/Tauri 改动 | 纯前端方案 |

---

## 组件设计

### `src/components/shared/ChartBlock.tsx`（新增）

**Props：**

```ts
interface ChartBlockProps {
  code: string; // AI 输出的原始 JSON 字符串
}
```

**内部结构：**

```
ChartBlock
├─ 解析阶段（useMemo）
│   ├─ JSON.parse(code) 成功 → option 对象
│   └─ 失败 → errorMessage 字符串
│
├─ 正常渲染
│   ├─ 顶部工具栏（与 CodeBlock 风格一致）
│   │   ├─ 左：图表类型标签（option.series[0]?.type，如 "bar"）
│   │   └─ 右：复制 JSON 按钮（Copy/Check icon，2s 反馈）
│   └─ <ReactECharts
│         option={option}
│         style={{ height: 280 }}
│         notMerge={true}
│         theme="dark-custom"
│       />
│
└─ 错误渲染
    └─ 红色 banner "图表数据格式有误"
       + 折叠显示原始 JSON（降级为 CodeBlock）
```

**主题配置：**

见下方 [ECharts 主题配置](#echarts-主题配置) 章节。

### `src/components/shared/MarkdownContent.tsx`（修改）

在现有 `code` 组件的 `if (match)` 分支中，最小侵入式添加：

```tsx
if (language === 'chart') {
  return <ChartBlock code={String(children).replace(/\n$/, '')} />;
}
// 否则走原有 CodeBlock 逻辑
return <CodeBlock language={language} code={...} />;
```

---

## 数据流

```
用户："帮我画一个柱状图，展示1-3月销售额"
    ↓
AI（参考 SKILL.md）生成输出：
    ```chart
    {
      "title": { "text": "月销售额" },
      "xAxis": { "type": "category", "data": ["1月","2月","3月"] },
      "yAxis": { "type": "value" },
      "series": [{ "name": "销售额", "type": "bar", "data": [120, 200, 150] }]
    }
    ```
    ↓
MarkdownContent → language="chart" → <ChartBlock code={...} />
    ↓
JSON.parse(code) → option 对象
    ↓
<ReactECharts option={option} /> 渲染图表
```

---

## 流式渲染

`StreamingMessage` 中的 `MarkdownContent` 逐字渲染 AI 输出。ReactMarkdown 的 `code` 组件**只在代码块完整闭合（` ``` ` 出现）后才触发**，因此 ChartBlock 天然只在 JSON 完整后才渲染，无需额外处理不完整 JSON 的情况。

---

## 错误处理

| 情况 | 处理方式 |
|------|----------|
| JSON 语法错误 | 红色 banner + 降级显示原始代码块 |
| option 缺少必要字段 | ECharts 自身容错，显示空/部分图表 |
| 渲染异常 | React ErrorBoundary 捕获，降级为代码块 |

---

## SKILL.md 补充

在 `src-tauri/skills/echarts-ai-skill/SKILL.md` 末尾追加：

```markdown
## open-db-studio 集成输出规则

在 open-db-studio 中，将最终 ECharts option 输出为 chart 代码块：

\```chart
{ "title": {...}, "xAxis": {...}, "series": [...] }
\```

不要输出 \```json 或 \```javascript，必须用 \```chart 标记。
```

---

---

## ECharts 主题配置

### 项目色彩系统

open-db-studio 使用深海军蓝 + 品牌青绿的暗色主题，从现有组件代码中提取的完整色盘：

| 角色 | 色值 | 使用场景 |
|------|------|----------|
| 主背景 | `#080d12` | App 根背景 |
| 代码背景 | `#0d1117` | CodeBlock、图表区域背景 |
| 面板背景 | `#111922` | 输入框、卡片 |
| 菜单背景 | `#151d28` | 浮层、Tooltip |
| 主边框 | `#1e2d42` | 分割线、卡片边框 |
| 次边框 | `#2a3f5a` | 次级分隔 |
| 主文字 | `#c8daea` | 正文、标签 |
| 次文字 | `#7a9bb8` | 说明文字、轴标签 |
| 弱文字 | `#4a6a8a` | 占位、禁用 |
| 品牌主色 | `#00c9a7` | 高亮、强调、第一系列 |
| 品牌次色 | `#009e84` | hover 态 |

### ECharts 主题对象

在 `ChartBlock.tsx` 中定义为模块级常量 `ODS_CHART_THEME`，通过 `echarts.registerTheme` 注册：

```ts
import * as echarts from 'echarts/core';

// 系列调色板：以品牌青绿为首，向蓝紫渐进，保证在深色背景上均可辨识
const COLOR_PALETTE = [
  '#00c9a7', // 品牌青绿（主系列）
  '#4a9eca', // 天蓝（第二系列）
  '#7b8ff0', // 蓝紫（第三系列）
  '#e07b54', // 暖橙（第四系列，对比色）
  '#f0c94a', // 琥珀黄（第五系列）
  '#a78bfa', // 柔紫（第六系列）
  '#34d399', // 翠绿（第七系列）
  '#f87171', // 玫红（第八系列）
];

export const ODS_CHART_THEME = {
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
    label: {
      backgroundColor: '#151d28',
      borderColor: '#2a3f5a',
      color: '#c8daea',
    },
  },

  // ── 坐标轴（categoryAxis / valueAxis 共用基础） ──
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

  // ── 系列默认样式 ──
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
      color: '#00c9a7',         // 阳线（涨）：品牌青绿
      color0: '#f87171',        // 阴线（跌）：玫红
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

  // ── 其他组件 ──
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
```

### 注册与使用

```ts
// ChartBlock.tsx 模块顶层（只执行一次）
echarts.registerTheme('ods-dark', ODS_CHART_THEME);

// ReactECharts 组件
<ReactECharts
  option={mergedOption}
  theme="ods-dark"
  style={{ height: 280 }}
  notMerge={true}
  opts={{ renderer: 'canvas' }}
/>
```

### option 合并策略

AI 输出的 `option` 中可能已包含颜色覆盖（如用户指定了 `color` 字段），需要保留用户意图同时确保背景正确：

```ts
const mergedOption = {
  backgroundColor: '#0d1117',  // 始终强制背景色
  ...parsedOption,              // AI 生成的 option（可覆盖 color 等字段）
};
```

背景色强制覆盖，其余字段尊重 AI 输出，主题作为默认值兜底。

---

## 依赖安装

```bash
npm install echarts@^5.6.0 echarts-for-react@^3.0.2
```

**Tree-shaking：** 不需要按需引入。`echarts-for-react` 在桌面 Tauri 应用中全量引入（gzip 后 ~300KB），包体积可接受，不配置 tree-shaking 以降低复杂度。

---

## ChartBlock 组件接口

```tsx
interface ChartBlockProps {
  code: string; // AI 输出的原始 ECharts option JSON 字符串
}
```

- 接收**原始 JSON 字符串**，在组件内部解析（与 CodeBlock 的 `code: string` 保持一致）
- 图表默认高度：**280px**（硬编码在 `style={{ height: 280 }}`，`echarts-for-react` 必须有明确高度）
- 图表类型标签：从 `option.series?.[0]?.type` 推断，读不到则显示 `"chart"`

---

## MarkdownContent.tsx 改动草稿

在现有 `mdComponents.code` 函数中，`if (match)` 分支内最前面添加：

```tsx
code({ className, children, ...props }) {
  const match = /language-(\w+)/.exec(className ?? '');
  const language = match ? match[1] : '';
  if (match) {
    // ── 新增：chart 标记渲染为 ECharts 图表 ──
    if (language === 'chart') {
      return <ChartBlock code={String(children).replace(/\n$/, '')} />;
    }
    // ── 原有逻辑 ──
    return <CodeBlock language={language} code={String(children).replace(/\n$/, '')} />;
  }
  return <code ...>{children}</code>;
}
```

`ChartBlock` 是纯渲染组件（内部只用 `useMemo` + `useState`，无 context 依赖），可安全放在模块级 `mdComponents` 常量中。ErrorBoundary 包裹在 `ChartBlock` 内部实现（组件自己处理渲染异常），不影响 `mdComponents` 的结构。

> **重要约定：** `mdComponents.code` 函数只负责分发（根据 `language` 决定渲染哪个组件），**不持有任何 state**。所有渲染状态（JSON 解析结果、错误状态、复制状态）必须放在 `ChartBlock` 组件内部，不得写在 `code` 函数的闭包中。

---

## 实现步骤概览

1. 安装依赖：`npm install echarts@^5.6.0 echarts-for-react@^3.0.2`
2. 新增 `src/components/shared/ChartBlock.tsx`
3. 修改 `src/components/shared/MarkdownContent.tsx`（在 `code` 组件 `if (match)` 分支开头加 `language === 'chart'` 判断）
4. 追加 `src-tauri/skills/echarts-ai-skill/SKILL.md` 集成规则
