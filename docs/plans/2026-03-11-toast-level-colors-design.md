# Toast 多级别消息提示色彩设计

日期：2026-03-11

## 背景

当前 Toast 组件仅支持单一样式（主题色 `#00c9a7` 背景），无法区分消息级别。
需要基于项目 Abyss 主题，为 5 种日志级别设计差异化背景色。

## 方案选择

采用**方案 A：半透明深色叠底**，语义色以 12% 透明度叠在深色基底上，
与 Abyss 暗色主题高度协调，优雅内敛。

## 色彩规范

| 级别 | 背景色 | 左边框 / 图标 / 文字 | Lucide 图标 |
|------|--------|----------------------|-------------|
| success | `rgba(74,222,128,0.12)` | `#4ade80` | `CheckCircle` |
| warning | `rgba(245,158,11,0.12)` | `#f59e0b` | `AlertTriangle` |
| error | `rgba(244,63,94,0.12)` | `#f43f5e` | `XCircle` |
| info | `rgba(94,178,247,0.12)` | `#5eb2f7` | `Info` |
| default | `rgba(0,201,167,0.12)` | `#00c9a7` | `Bell` |

辅助边框：`border: 1px solid rgba(语义色, 0.25)`
左边框：`border-left: 3px solid 语义色`

## 组件接口

```typescript
type ToastLevel = 'success' | 'warning' | 'error' | 'info' | 'default'

interface ToastProps {
  message: string | null
  level?: ToastLevel  // 默认 'default'
}
```

## showToast 签名变更

```typescript
// App.tsx 中
const showToast = (msg: string, level: ToastLevel = 'default') => { ... }
```

全局 store / context 中 `showToast` 同步更新参数签名，
现有调用（单参数）保持向后兼容。

## 视觉结构

```
┌─ 3px 彩色左边框 ───────────────────────────────┐
│  [图标]  消息文本                               │
└────────────────────────────────────────────────┘
```

位置：`top-6 left-1/2 -translate-x-1/2`（保持不变）
字号：`text-[13px]`（与全局一致）
动画：保留现有 `transition-opacity`
