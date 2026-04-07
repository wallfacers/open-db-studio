# FRONTEND.md — 前端开发规范

## 组件结构

- 每个组件一个目录，入口文件为 `index.tsx`
- 子组件放在同目录（如 `Explorer/TreeItem.tsx`）
- 命名：PascalCase，目录与组件名一致

## 颜色系统使用规范

### 基本原则

1. **必须使用 CSS 变量**：禁止在代码中硬编码颜色值
2. **语义化选择**：根据用途选择变量，而非颜色外观
3. **使用 Tailwind 语义类名**：禁止 `var()` 包装器，使用 `@theme` 映射后的类名
4. **强制交互过渡**：所有颜色变化的交互必须搭配 `transition-colors duration-200`

### 使用示例

```tsx
// ✅ 正确：使用 Tailwind 语义类名 + 交互过渡
<div className="bg-background-panel text-foreground">
<button className="bg-primary hover:bg-primary-hover transition-colors duration-200">
<span className="text-error">错误信息</span>
<div className="bg-primary/80">80% 透明度</div>

// ❌ 禁止：var() 包装器（反模式，不支持透明度修饰符）
<div className="bg-[var(--background-panel)] text-[var(--foreground)]">
<button className="bg-[var(--primary)] hover:bg-[var(--primary-hover)]">

// ❌ 禁止：硬编码颜色值
<div className="bg-[#111922] text-[#c8daea]">
<button className="bg-[#00c9a7]">

// ❌ 禁止：Tailwind 原生颜色类
<span className="text-red-400">
<span className="text-white">
<div className="bg-gray-800">

// ❌ 禁止：无过渡的颜色变化（产生廉价感）
<button className="bg-primary hover:bg-primary-hover">
```

### 常用场景速查表

| 场景 | Tailwind 类名 | 必须搭配 |
|------|--------------|----------|
| 页面/应用背景 | `bg-background-base` | — |
| 侧边栏/面板 | `bg-background-panel` | — |
| 卡片/弹窗 | `bg-background-card` | — |
| Hover 状态 | `hover:bg-background-hover` | `transition-colors duration-150` |
| 主按钮 | `bg-primary text-primary-foreground` | `hover:bg-primary-hover transition-colors duration-200` |
| 次按钮 | `bg-secondary text-secondary-foreground` | `hover:bg-secondary-hover transition-colors duration-200` |
| 执行/运行按钮 | `bg-accent text-accent-foreground` | `hover:bg-accent-hover transition-colors duration-200` |
| 主文字 | `text-foreground` | — |
| 次要文字 | `text-foreground-muted` | — |
| 占位符文字 | `text-foreground-subtle` | — |
| 默认边框 | `border-border` | — |
| 焦点边框 | `focus:border-border-focus` | `transition-colors duration-200` |
| 成功状态 | `text-success` / `bg-success-subtle` | — |
| 错误状态 | `text-error` / `bg-error-subtle` | — |
| 警告状态 | `text-warning` / `bg-warning-subtle` | — |

### 交互过渡要求

所有涉及颜色变化的交互**必须**添加过渡动画：

```tsx
// 按钮
<button className="... transition-colors duration-200">

// 列表项
<li className="hover:bg-background-hover transition-colors duration-150">

// 焦点输入框
<input className="border-border focus:border-border-focus transition-colors duration-200">

// 多属性过渡（颜色+阴影+变换）
<div className="... transition-all duration-200">
```

### 完整颜色定义

所有 CSS 变量定义在 `src/index.css` 的 `:root` 中，通过 `@theme` 指令映射为 Tailwind 语义类名。包含：
- 核心语义色（Primary / Secondary / Accent）
- 背景层级（Background Scale）
- 文字层级（Foreground Scale）
- 边框层级（Border Scale）
- 语义状态色（Success / Warning / Error / Info）
- 数据可视化色板

详见 [DESIGN.md](./DESIGN.md) 颜色系统章节。

## Zustand Store

- 每个业务领域一个 store 文件（`store/connections.ts` 等）
- Store 只存 UI 状态和从 Rust 同步的数据
- 异步操作（invoke 调用）放在 store action 中，不放在组件里

## Tauri invoke 封装规范

所有 invoke 调用封装在 `src/hooks/` 中，不在组件内直接调用：

```typescript
// 正确（封装在 hooks/useConnections.ts）
export function useConnections() {
  const setConnections = useConnectionStore(s => s.setConnections);
  const fetchConnections = async () => {
    const list = await invoke<Connection[]>('list_connections');
    setConnections(list);
  };
  return { fetchConnections };
}
```

## 类型定义

- Rust 数据结构在 `src/types/` 中对应定义 TypeScript 接口
- 字段名约定：Rust snake_case → TypeScript camelCase
