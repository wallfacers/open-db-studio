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

### Tailwind 主题映射（@theme 指令）

**禁止直接在组件中使用 `var()` 包装器**（如 `text-[var(--error)]`）。这是反模式：
- 降低代码可读性
- 无法使用 Tailwind 透明度修饰符（如 `bg-primary/80`）
- 不利于 IDE 自动补全

所有 CSS 变量必须通过 `src/index.css` 的 `@theme` 指令映射为 Tailwind 语义类名：

```css
@theme {
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-primary-hover: var(--primary-hover);
  --color-primary-active: var(--primary-active);
  --color-primary-subtle: var(--primary-subtle);

  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-secondary-hover: var(--secondary-hover);

  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-accent-hover: var(--accent-hover);
  --color-accent-subtle: var(--accent-subtle);

  --color-background: var(--background);
  --color-background-void: var(--background-void);
  --color-background-base: var(--background-base);
  --color-background-panel: var(--background-panel);
  --color-background-card: var(--background-card);
  --color-background-elevated: var(--background-elevated);
  --color-background-hover: var(--background-hover);
  --color-background-active: var(--background-active);
  --color-background-deep: var(--background-deep);
  --color-background-code: var(--background-code);

  --color-foreground: var(--foreground);
  --color-foreground-default: var(--foreground-default);
  --color-foreground-muted: var(--foreground-muted);
  --color-foreground-subtle: var(--foreground-subtle);
  --color-foreground-ghost: var(--foreground-ghost);

  --color-border: var(--border);
  --color-border-subtle: var(--border-subtle);
  --color-border-strong: var(--border-strong);
  --color-border-focus: var(--border-focus);

  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
  --color-success-subtle: var(--success-subtle);

  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-warning-subtle: var(--warning-subtle);

  --color-error: var(--error);
  --color-error-foreground: var(--error-foreground);
  --color-error-subtle: var(--error-subtle);

  --color-info: var(--info);
  --color-info-foreground: var(--info-foreground);
  --color-info-subtle: var(--info-subtle);

  --color-ring: var(--ring);
  --color-ring-accent: var(--ring-accent);
  --color-overlay: var(--overlay);

  --color-danger-hover-bg: var(--danger-hover-bg);
  --color-window-close-hover: var(--window-close-hover);
}
```

### 使用示例

```tsx
// ✅ 正确：使用 Tailwind 语义类名（支持透明度修饰符）
<button className="bg-primary text-primary-foreground hover:bg-primary-hover transition-colors duration-200">
<div className="bg-background-panel border border-border">
<h1 className="text-foreground">主标题</h1>
<p className="text-foreground-muted">次要描述</p>
<div className="bg-error-subtle text-error">错误信息</div>
<div className="bg-primary/80">80% 透明度</div>

// ❌ 禁止：var() 包装器
<button className="bg-[var(--primary)] text-[var(--primary-foreground)]">
<div className="text-[var(--foreground-muted)]">
```

### 颜色使用规范

1. **禁止使用硬编码色值**：所有颜色必须通过 CSS 变量引用
2. **语义化命名**：根据用途选择变量，而非直接选择颜色
3. **对比度要求**：文字与背景对比度必须 ≥ 4.5:1（WCAG AA）
4. **浅色模式**：支持 `prefers-color-scheme: light` 媒体查询
5. **禁止 var() 包装器**：使用 `@theme` 映射后的语义类名（`text-error` 而非 `text-[var(--error)]`）
6. **强制交互过渡**：所有涉及颜色变化的交互状态必须搭配 `transition-colors duration-200`（或 `duration-300`），避免状态突变

### 交互过渡规范（Transition）

所有涉及颜色变化的交互必须添加过渡动画，避免状态突变产生廉价感：

| 场景 | 必须搭配的 Tailwind 类 |
|------|----------------------|
| 按钮 hover/active | `transition-colors duration-200` |
| 列表项 hover | `transition-colors duration-150` |
| 焦点边框 | `transition-colors duration-200` |
| 背景色切换（Tab/选中） | `transition-colors duration-200` |
| 图标 hover 变色 | `transition-colors duration-150` |
| 复杂多属性过渡（颜色+阴影+变换） | `transition-all duration-200` |

```tsx
// ✅ 正确：带过渡的交互
<button className="bg-primary hover:bg-primary-hover transition-colors duration-200">
<li className="hover:bg-background-hover transition-colors duration-150">
<input className="border-border focus:border-border-focus transition-colors duration-200">

// ❌ 禁止：无过渡的颜色变化
<button className="bg-primary hover:bg-primary-hover">
<li className="hover:bg-background-hover">
```

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
