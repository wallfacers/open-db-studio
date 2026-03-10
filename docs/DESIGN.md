# DESIGN.md — UI/UX 设计规范

## 主题

- 基础主题：VSCode Dark
- 禁止使用内联 style，所有样式通过 Tailwind 类名

## 颜色 Token

| 用途 | 值 |
|------|-----|
| 背景主色 | `#141414` |
| 面板背景 | `#1e1e1e` |
| 边框 | `#2b2b2b` |
| 文字主色 | `#cccccc` |
| 文字次色 | `#888888` |
| 强调色（蓝） | `#569cd6` |
| 成功色（绿） | `#4ec9b0` |
| 错误色（红） | `#f44747` |

## 布局

- VSCode 三栏布局：ActivityBar（48px）+ Explorer（可调宽）+ 主内容 + Assistant（可调宽）
- 所有面板宽度可拖拽调整，最小宽度不得低于 150px
- 字体大小统一 13px（`text-[13px]`）

## 组件约定

- 图标库：lucide-react
- 动画：motion（仅用于必要的 UX 反馈）
- 禁止引入 shadcn/antd 等外部 UI 组件库
