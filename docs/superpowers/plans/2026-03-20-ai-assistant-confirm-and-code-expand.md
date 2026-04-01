<!-- STATUS: ✅ 已实现 -->
# AI 助手：确认框接入 & 代码块放大弹框 实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AI 助手的删除/清空操作接入全局确认框，并为代码块新增放大查看弹框。

**Architecture:** 功能1 在 `Assistant/index.tsx` 中用 `useConfirmStore().confirm()` 替换三处直接删除调用；功能2 在 `MarkdownContent.tsx` 的 `CodeBlock` 组件内新增本地 `expanded` state，通过 `ReactDOM.createPortal` 渲染全屏弹框，避免被父容器裁剪。两处改动完全独立，互不影响。

**Tech Stack:** React 18、TypeScript、Zustand（`useConfirmStore`）、`lucide-react`（`Maximize2`、`X`）、`react-dom`（`createPortal`）、`react-syntax-highlighter`

**Spec:** `docs/superpowers/specs/2026-03-20-ai-assistant-confirm-and-code-expand-design.md`

---

## Chunk 1：功能1 — 删除/清空操作接入全局确认框

### Task 1：`Assistant/index.tsx` 接入 `useConfirmStore`

**Files:**
- Modify: `src/components/Assistant/index.tsx`

- [ ] **Step 1：在文件顶部引入 `useConfirmStore`**

  在 `import { useAppStore }` 所在行之后添加：

  ```typescript
  import { useConfirmStore } from '../../store/confirmStore';
  ```

- [ ] **Step 2：在组件内获取 `confirm` 函数**

  在 `const { t } = useTranslation();` 之后添加：

  ```typescript
  const confirm = useConfirmStore((s) => s.confirm);
  ```

- [ ] **Step 3：改写「清空当前会话消息」按钮**

  定位到 Header 中的 Trash2 图标（约第 503 行）：

  ```tsx
  // 原代码：
  <span title={t('assistant.clearHistory')} className="flex items-center cursor-pointer hover:text-red-400" onClick={() => { clearHistory(currentSessionId); showToast(t('assistant.historyCleared'), 'info'); }}>
    <Trash2 size={16} />
  </span>

  // 改为：
  <span
    title={t('assistant.clearHistory')}
    className="flex items-center cursor-pointer hover:text-red-400"
    onClick={async () => {
      const ok = await confirm({
        title: '清空对话',
        message: '确定清空当前对话记录？此操作不可恢复。',
        variant: 'danger',
      });
      if (!ok) return;
      clearHistory(currentSessionId);
      showToast(t('assistant.historyCleared'), 'info');
    }}
  >
    <Trash2 size={16} />
  </span>
  ```

- [ ] **Step 4：改写「删除单个历史会话」按钮**

  定位到历史列表中的 Trash2 删除按钮（约第 574 行）：

  ```tsx
  // 原代码：
  <button
    className="opacity-0 group-hover:opacity-100 p-0.5 text-[#4a6a8a] hover:text-red-400 transition-all flex-shrink-0"
    title={t('assistant.deleteSession')}
    onClick={(e) => { e.stopPropagation(); deleteSession(sess.id); }}
  >
    <Trash2 size={12} />
  </button>

  // 改为：
  <button
    className="opacity-0 group-hover:opacity-100 p-0.5 text-[#4a6a8a] hover:text-red-400 transition-all flex-shrink-0"
    title={t('assistant.deleteSession')}
    onClick={async (e) => {
      e.stopPropagation();
      const ok = await confirm({
        title: '删除会话',
        message: '确定删除该会话？此操作不可恢复。',
        variant: 'danger',
      });
      if (!ok) return;
      deleteSession(sess.id);
    }}
  >
    <Trash2 size={12} />
  </button>
  ```

- [ ] **Step 5：改写「删除全部会话」按钮，移除内联确认 UI**

  删除 `confirmDeleteAll` state 声明（约第 242 行）：
  ```typescript
  // 删除此行：
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  ```

  将历史面板底部的「清除所有会话」区域（约第 588-618 行）替换为：

  ```tsx
  {sessions.length > 0 && (
    <div className="px-3 py-2 border-t border-[#1e2d42] flex-shrink-0">
      <button
        className="w-full flex items-center justify-center gap-2 py-1.5 text-xs text-[#7a9bb8] hover:text-red-400 hover:bg-[#1e2d42] rounded transition-colors"
        onClick={async () => {
          const ok = await confirm({
            title: '删除所有会话',
            message: '确定删除全部会话记录？此操作不可恢复。',
            variant: 'danger',
          });
          if (!ok) return;
          deleteAllSessions();
          setShowHistory(false);
          showToast(t('assistant.allSessionsDeleted'), 'info');
        }}
      >
        <Trash2 size={13} />
        <span>{t('assistant.deleteAllSessions')}</span>
      </button>
    </div>
  )}
  ```

- [ ] **Step 6：TypeScript 类型检查**

  ```bash
  cd /d/project/java/source/open-db-studio && npx tsc --noEmit
  ```

  预期：无报错输出。

- [ ] **Step 7：手动验证**

  1. `npm run dev` 启动前端
  2. 点击「清空对话」图标 → 确认框弹出，点取消不清空，点确认清空
  3. 打开历史面板，hover 会话 → 点删除图标 → 确认框弹出，行为正确
  4. 历史面板底部点「删除所有会话」→ 确认框弹出，行为正确
  5. 确认框样式与现有 `ConfirmDialog` 一致（红色按钮，深色背景）

- [ ] **Step 8：提交**

  ```bash
  cd /d/project/java/source/open-db-studio
  git add src/components/Assistant/index.tsx
  git commit -m "feat(assistant): 清空和删除操作接入全局确认框"
  ```

---

## Chunk 2：功能2 — 代码块放大弹框

### Task 2：`MarkdownContent.tsx` 新增代码块放大功能

**Files:**
- Modify: `src/components/shared/MarkdownContent.tsx`

- [ ] **Step 1：添加 `ReactDOM` 和 `Maximize2`、`X` 图标引入**

  修改文件顶部的 import（`react-dom` 是标准 React 依赖，`package.json` 中已存在，无需安装）：

  ```typescript
  // 原：
  import React, { useState, useCallback, memo } from 'react';
  // 改为（不添加 useEffect 到具名 import，全文统一使用 React.useEffect 命名空间风格）：
  import React, { useState, useCallback, memo } from 'react';
  import ReactDOM from 'react-dom';

  // 原：
  import { Copy, Check } from 'lucide-react';
  // 改为：
  import { Copy, Check, Maximize2, X } from 'lucide-react';
  ```

- [ ] **Step 2：新增 `CodeExpandModal` 组件**

  在第 9 行的 `// ── 代码块 ──` 注释**之前**插入（保留原注释行不删除）：

  ```tsx
  // ── 代码放大弹框 ─────────────────────────────────────────────────────────────
  const CodeExpandModal: React.FC<{
    language: string;
    code: string;
    onClose: () => void;
  }> = ({ language, code, onClose }) => {
    const [copied, setCopied] = useState(false);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    // 全文统一使用 React.useEffect 命名空间风格（与 CodeBlock 保持一致）
    React.useEffect(() => {
      const handler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') onClose();
      };
      document.addEventListener('keydown', handler);
      return () => {
        document.removeEventListener('keydown', handler);
        if (timerRef.current) clearTimeout(timerRef.current);
      };
    }, [onClose]);

    const handleCopy = useCallback(async () => {
      try {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 2000);
      } catch {
        // 静默失败
      }
    }, [code]);

    return ReactDOM.createPortal(
      <div
        className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70"
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div className="bg-[#111922] border border-[#253347] rounded-lg shadow-2xl w-[90vw] max-w-5xl max-h-[85vh] flex flex-col overflow-hidden">
          {/* 弹框头部 */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-[#161b22] border-b border-[#1e2d42] flex-shrink-0">
            <span className="text-xs text-[#7a9bb8] font-mono">{language || 'plaintext'}</span>
            <div className="flex items-center gap-3">
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 text-xs text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
              >
                {copied ? (
                  <><Check size={13} className="text-[#00c9a7]" /><span className="text-[#00c9a7]">已复制</span></>
                ) : (
                  <><Copy size={13} /><span>复制</span></>
                )}
              </button>
              <button
                onClick={onClose}
                className="text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
                title="关闭"
              >
                <X size={16} />
              </button>
            </div>
          </div>
          {/* 代码区域：overflow-auto 覆盖横纵两个方向 */}
          <div className="flex-1 overflow-auto">
            <SyntaxHighlighter
              style={oneDark}
              language={language || 'plaintext'}
              useInlineStyles={false}
              PreTag="div"
              customStyle={{ margin: 0, borderRadius: 0, fontSize: '13px', background: '#0d1117', padding: '16px', minHeight: '100%', overflowX: 'auto' }}
              codeTagProps={{ style: { background: 'transparent' } }}
            >
              {code}
            </SyntaxHighlighter>
          </div>
        </div>
      </div>,
      document.body
    );
  };
  ```

- [ ] **Step 3：改写 `CodeBlock` 组件，新增放大按钮**

  整体替换 `CodeBlock`（包含原 `// ── 代码块 ──` 注释行）。返回值改为 `<>...</>` Fragment 以附加弹框，Fragment 作为 `react-markdown` 的 code 组件 prop 的子节点是安全的。

  ```tsx
  // ── 代码块 ───────────────────────────────────────────────────────────────────
  // 原 CodeBlock（保留复制逻辑，新增 expanded state 和放大按钮）：
  const CodeBlock: React.FC<{ language: string; code: string }> = memo(({ language, code }) => {
    const [copied, setCopied] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
      return () => { if (timerRef.current) clearTimeout(timerRef.current); };
    }, []);

    const handleCopy = useCallback(async () => {
      try {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 2000);
      } catch {
        // clipboard 不可用时静默失败
      }
    }, [code]);

    return (
      <>
        <div className="my-2 rounded overflow-hidden border border-[#1e2d42]">
          <div className="flex items-center justify-between px-3 py-1.5 bg-[#161b22] border-b border-[#1e2d42]">
            <span className="text-xs text-[#7a9bb8] font-mono">{language || 'plaintext'}</span>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setExpanded(true)}
                className="flex items-center gap-1 text-xs text-[#7a9bb8] hover:text-[#c8daea] transition-colors"
                title="放大查看"
              >
                <Maximize2 size={12} />
              </button>
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
          </div>
          <SyntaxHighlighter
            style={oneDark}
            language={language || 'plaintext'}
            useInlineStyles={false}
            PreTag="div"
            customStyle={{ margin: 0, borderRadius: 0, fontSize: '12px', background: '#0d1117', padding: '12px', overflowX: 'auto' }}
            codeTagProps={{ style: { background: 'transparent' } }}
          >
            {code}
          </SyntaxHighlighter>
        </div>
        {expanded && (
          <CodeExpandModal
            language={language}
            code={code}
            onClose={() => setExpanded(false)}
          />
        )}
      </>
    );
  });
  ```

- [ ] **Step 4：TypeScript 类型检查**

  ```bash
  cd /d/project/java/source/open-db-studio && npx tsc --noEmit
  ```

  预期：无报错输出。

- [ ] **Step 5：手动验证**

  1. `npm run dev` 启动前端
  2. 在 AI 助手中触发一个带代码块的回答（或测试已有历史消息）
  3. 代码块头部工具栏出现放大图标（在复制按钮左侧）
  4. 点击放大图标 → 弹框弹出，展示完整代码，语言标签正确
  5. 弹框内复制按钮可用，点击关闭或按 Escape 或点遮罩均可关闭
  6. 弹框样式与项目主题一致（深色背景，边框 `#253347`）
  7. 长代码内容可滚动

- [ ] **Step 6：提交**

  ```bash
  cd /d/project/java/source/open-db-studio
  git add src/components/shared/MarkdownContent.tsx
  git commit -m "feat(assistant): 代码块新增放大查看弹框"
  ```
