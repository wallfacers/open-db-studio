<!-- STATUS: ✅ 已实现 -->
# Toast 多级别消息提示色彩 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 Toast 组件添加 5 种消息级别（success/warning/error/info/default），每种级别使用不同的半透明背景色，与 Abyss 深色主题协调。

**Architecture:** 修改 Toast 组件接口新增 `level` 可选参数，在 App.tsx 中同步扩展 state 和 showToast 函数，对全局已有的调用按语义补全 level 参数。

**Tech Stack:** React 18, TypeScript, Tailwind v4, lucide-react

---

## Task 1：更新 Toast 组件

**Files:**
- Modify: `src/components/Toast/index.tsx`

**Step 1：替换整个 Toast 组件**

将 `src/components/Toast/index.tsx` 全部替换为：

```tsx
import React from 'react';
import { Bell, CheckCircle, AlertTriangle, XCircle, Info } from 'lucide-react';

export type ToastLevel = 'success' | 'warning' | 'error' | 'info' | 'default';

interface ToastProps {
  message: string | null;
  level?: ToastLevel;
}

const LEVEL_CONFIG: Record<ToastLevel, {
  bg: string;
  border: string;
  color: string;
  Icon: React.ElementType;
}> = {
  success: {
    bg: 'rgba(74,222,128,0.12)',
    border: '#4ade80',
    color: '#4ade80',
    Icon: CheckCircle,
  },
  warning: {
    bg: 'rgba(245,158,11,0.12)',
    border: '#f59e0b',
    color: '#f59e0b',
    Icon: AlertTriangle,
  },
  error: {
    bg: 'rgba(244,63,94,0.12)',
    border: '#f43f5e',
    color: '#f43f5e',
    Icon: XCircle,
  },
  info: {
    bg: 'rgba(94,178,247,0.12)',
    border: '#5eb2f7',
    color: '#5eb2f7',
    Icon: Info,
  },
  default: {
    bg: 'rgba(0,201,167,0.12)',
    border: '#00c9a7',
    color: '#00c9a7',
    Icon: Bell,
  },
};

export const Toast: React.FC<ToastProps> = ({ message, level = 'default' }) => {
  if (!message) return null;
  const { bg, border, color, Icon } = LEVEL_CONFIG[level];
  return (
    <div
      className="fixed top-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded shadow-lg z-50 transition-opacity flex items-center space-x-2 text-[13px]"
      style={{
        background: bg,
        border: `1px solid ${border}33`,
        borderLeft: `3px solid ${border}`,
        color,
      }}
    >
      <Icon size={15} />
      <span>{message}</span>
    </div>
  );
};
```

**Step 2：确认编译无报错**

```bash
npx tsc --noEmit
```

Expected：无错误输出（或仅有与此次修改无关的已有错误）

**Step 3：Commit**

```bash
git add src/components/Toast/index.tsx
git commit -m "feat(toast): add multi-level color support with Abyss theme"
```

---

## Task 2：更新 App.tsx 中的 state 和 showToast

**Files:**
- Modify: `src/App.tsx`

**Step 1：扩展 state**

将 `App.tsx` 第 89 行附近的：

```typescript
const [toastMessage, setToastMessage] = useState<string | null>(null);

const showToast = (msg: string) => {
  setToastMessage(msg);
  setTimeout(() => setToastMessage(null), 3000);
};
```

替换为：

```typescript
const [toast, setToast] = useState<{ message: string; level: import('./components/Toast').ToastLevel } | null>(null);

const showToast = (msg: string, level: import('./components/Toast').ToastLevel = 'default') => {
  setToast({ message: msg, level });
  setTimeout(() => setToast(null), 3000);
};
```

**Step 2：更新 Toast 组件使用处**

将 `App.tsx` 第 352 行附近的：

```tsx
<Toast message={toastMessage} />
```

替换为：

```tsx
<Toast message={toast?.message ?? null} level={toast?.level} />
```

**Step 3：更新 App.tsx 内部的 showToast 调用（第 199 行）**

将：
```typescript
showToast('SQL 格式化失败');
```
改为：
```typescript
showToast('SQL 格式化失败', 'error');
```

**Step 4：确认编译无报错**

```bash
npx tsc --noEmit
```

**Step 5：Commit**

```bash
git add src/App.tsx
git commit -m "feat(toast): extend showToast with level param in App"
```

---

## Task 3：更新各子组件的 showToast 调用级别

### 3.1 错误类调用 → `'error'`

以下文件中，`showToast(String(e))` 和明确的失败提示统一加 `'error'` 参数：

| 文件 | 改动 |
|------|------|
| `src/components/AiCreateTableDialog/index.tsx` L30,43 | `showToast(String(e), 'error')` |
| `src/components/ExportDialog/index.tsx` L45 | `showToast(String(e), 'error')` |
| `src/components/Explorer/index.tsx` L54 | `showToast(errMsg, 'error')` |
| `src/components/IndexManager/index.tsx` L41,59 | `showToast(String(e), 'error')` |
| `src/components/MainContent/index.tsx` L209,243,257 | `showToast(error, 'error')` / `showToast(..., 'error')` |
| `src/components/MainContent/TableDataView.tsx` L51,93,107 | `showToast(String(e), 'error')` |
| `src/components/TableManageDialog/index.tsx` L43,58 | `showToast(String(e), 'error')` |
| `src/components/ObjectPanel/index.tsx` L28 | `.catch(e => showToast(String(e), 'error'))` |

### 3.2 成功类调用 → `'success'`

| 文件 | 改动 |
|------|------|
| `src/components/AiCreateTableDialog/index.tsx` L39 | `showToast(..., 'success')` |
| `src/components/ExportDialog/index.tsx` L42 | `showToast(..., 'success')` |
| `src/components/Explorer/DBTree.tsx` L387,409,428,440 | `showToast(..., 'success')` |
| `src/components/IndexManager/index.tsx` L38,54 | `showToast(..., 'success')` |
| `src/components/MainContent/TableDataView.tsx` L89,104 | `showToast(..., 'success')` |
| `src/components/TableManageDialog/index.tsx` L39,54 | `showToast(..., 'success')` |
| `src/components/Assistant/index.tsx` L111 | `showToast(..., 'success')` |

### 3.3 警告类调用 → `'warning'`

| 文件 | 改动 |
|------|------|
| `src/components/MainContent/index.tsx` L216,236,250 | `showToast(..., 'warning')` |
| `src/components/IndexManager/index.tsx` L47 | `showToast(..., 'warning')` |

### 3.4 信息类调用 → `'info'`（保留 default 不动的维持默认）

| 文件 | 改动 |
|------|------|
| `src/components/Assistant/index.tsx` L71,74,75,76,134 | `showToast(..., 'info')` |
| `src/components/ActivityBar/index.tsx` L36,127 | `showToast(..., 'info')` |
| `src/components/MainContent/index.tsx` L411,417 | `showToast(..., 'info')` |

**Step 1：逐文件修改上述调用**

（按文件一个一个来，每个文件改完后用 tsc 确认）

**Step 2：最终编译检查**

```bash
npx tsc --noEmit
```

Expected：无错误

**Step 3：Commit**

```bash
git add src/components/
git commit -m "feat(toast): apply level semantics to all showToast call sites"
```

---

## 验收标准

- [ ] Toast 出现时根据 level 显示对应背景色和图标
- [ ] 默认级别（无第二参数）仍为主题色 `#00c9a7`
- [ ] 所有已有功能的 showToast 调用均已加上语义级别
- [ ] `npx tsc --noEmit` 无类型错误
