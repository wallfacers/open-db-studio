# DESIGN.md — UI/UX 设计规范

## 主题

- 基础主题：Abyss Indigo（品牌差异化深色主题）
- 设计系统：基于 Tailwind CSS Slate 背景 + Indigo 品牌色
- 禁止使用内联 style，所有样式通过 Tailwind 类名或 CSS 变量

## 颜色系统（Color System v3.0 — Indigo Brand）

基于 SaaS 开发者工具专业配色，品牌差异化 Indigo 主色，符合 WCAG AA 对比度标准。

### 设计一致性原则

**同概念 = 同样式**：相同语义的操作在全应用范围内必须使用相同的颜色 token，不允许同一概念出现不同颜色。

| 概念 | 对应 Token | 禁止 |
|------|-----------|------|
| 主要操作（确认、保存、提交） | `--primary` | 不同页面用不同蓝/紫 |
| 执行/运行（Run SQL、Execute） | `--accent` | 混用 primary 或 success |
| 成功状态（已完成、通过） | `--success` | 混用 accent |
| 错误状态（失败、校验不通过） | `--error` | 混用 warning |
| 警告状态（注意、风险提示） | `--warning` | 混用 error |
| 信息提示（说明、通知） | `--info` | 混用 primary |
| 焦点/选中指示 | `--border-focus` / `--ring` | 使用 primary 直接色值 |

### 核心语义色彩

| Token | CSS 变量 | 用途 | 色值 |
|-------|----------|------|------|
| **Primary** | `--primary` | 品牌色、主要按钮、链接 | `#6366F1` (indigo-500) |
| **Primary Hover** | `--primary-hover` | Primary 悬停态 | `#4F46E5` (indigo-600) |
| **Accent** | `--accent` | 执行/运行按钮、强调 | `#10B981` (emerald-500) |
| **Accent Hover** | `--accent-hover` | Accent 悬停态 | `#059669` (emerald-600) |

### 背景层级（从深到浅）

| Token | CSS 变量 | 用途 | 色值 |
|-------|----------|------|------|
| **Background Void** | `--background-void` | 最深背景、遮罩 | `#020617` (slate-950) |
| **Background Base** | `--background-base` | 应用根节点背景 | `#0F172A` (slate-900) |
| **Background Panel** | `--background-panel` | 面板、侧边栏 | `#1E293B` (slate-800) |
| **Background Elevated** | `--background-elevated` | 卡片、悬浮面板 | `#27354F` |
| **Background Hover** | `--background-hover` | Hover 状态背景 | `#334155` (slate-700) |
| **Background Active** | `--background-active` | 选中/激活背景 | `#252363` (dark indigo) |

### 文字层级

| Token | CSS 变量 | 用途 | 色值 |
|-------|----------|------|------|
| **Foreground** | `--foreground` | 主文字、标题 | `#F8FAFC` (slate-50) |
| **Foreground Default** | `--foreground-default` | 正文 | `#E2E8F0` (slate-200) |
| **Foreground Muted** | `--foreground-muted` | 次要信息 | `#94A3B8` (slate-400) |
| **Foreground Subtle** | `--foreground-subtle` | 占位符 | `#64748B` (slate-500) |
| **Foreground Ghost** | `--foreground-ghost` | 禁用状态 | `#475569` (slate-600) |

### 边框层级

| Token | CSS 变量 | 用途 | 色值 |
|-------|----------|------|------|
| **Border Subtle** | `--border-subtle` | 极细分隔线 | `#1E293B` (slate-800) |
| **Border Default** | `--border` | 默认边框 | `#334155` (slate-700) |
| **Border Strong** | `--border-strong` | 强调边框 | `#475569` (slate-600) |
| **Border Focus** | `--border-focus` | 焦点边框 | `#818CF8` (indigo-400) |

### 语义状态色

| Token | CSS 变量 | 用途 | 色值 |
|-------|----------|------|------|
| **Success** | `--success` | 成功提示 | `#22C55E` (green-500) |
| **Success Subtle** | `--success-subtle` | 成功背景 | `#14532D` (green-900) |
| **Warning** | `--warning` | 警告提示 | `#F59E0B` (amber-500) |
| **Warning Subtle** | `--warning-subtle` | 警告背景 | `#78350F` (amber-900) |
| **Error** | `--error` | 错误提示 | `#EF4444` (red-500) |
| **Error Subtle** | `--error-subtle` | 错误背景 | `#7F1D1D` (red-900) |
| **Info** | `--info` | 信息提示 | `#3B82F6` (blue-500) |
| **Info Subtle** | `--info-subtle` | 信息背景 | `#1E3A8A` (blue-900) |

### 数据可视化色板

```
--data-blue:   #3B82F6
--data-green:  #22C55E
--data-amber:  #F59E0B
--data-red:    #EF4444
--data-purple: #A855F7
--data-cyan:   #06B6D4
--data-pink:   #EC4899
```

### 使用示例

```tsx
// 主按钮
<button className="bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary-hover)]">

// 面板容器
<div className="bg-[var(--background-panel)] border border-[var(--border)]">

// 文字层级
<h1 className="text-[var(--foreground)]">主标题</h1>
<p className="text-[var(--foreground-muted)]">次要描述</p>

// 状态提示
<div className="bg-[var(--error-subtle)] text-[var(--error)]">错误信息</div>
```

### 颜色使用规范

1. **禁止使用硬编码色值**：所有颜色必须通过 CSS 变量引用
2. **语义化命名**：根据用途选择变量，而非直接选择颜色
3. **对比度要求**：文字与背景对比度必须 ≥ 4.5:1（WCAG AA）
4. **浅色模式**：支持 `prefers-color-scheme: light` 媒体查询

### 旧版兼容（已废弃）

以下变量已废弃，新代码请勿使用：
- `--bg-void`, `--bg-base`, `--bg-panel` → 使用 `--background-*`
- `--text-ghost`, `--text-muted` → 使用 `--foreground-*`
- `--accent-deep`, `--accent-muted` → 使用 `--accent-*`
- `--color-success` → 使用 `--success`

## 布局

- VSCode 三栏布局：ActivityBar（48px）+ Explorer（可调宽）+ 主内容 + Assistant（可调宽）
- 所有面板宽度可拖拽调整，最小宽度不得低于 150px
- 字体大小统一 13px（`text-[13px]`）

## 组件约定

- 图标库：lucide-react
- 动画：motion（仅用于必要的 UX 反馈）
- 禁止引入 shadcn/antd 等外部 UI 组件库

## 浅色模式

```css
@media (prefers-color-scheme: light) {
  :root {
    --background: #F8FAFC;
    --background-base: #F8FAFC;
    --foreground: #0F172A;
    --border: #E2E8F0;
    /* ... 其他变量相应调整 */
  }
}
```
