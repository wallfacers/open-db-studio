# Security Fix & Page-Agent Cleanup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 移除 page-agent 集成，修复 API Key / 数据库密码不应暴露到前端的安全问题，并为编辑弹窗实现"小眼睛查看 + 未修改不覆盖"机制。

**Architecture:** Rust 侧新增 `get_llm_config_key` / `get_connection_password` 命令（按需返回明文），`list_llm_configs` 返回时遮蔽 `api_key`（空串）；前端编辑弹窗用 `isDirty` 状态追踪密码字段，未修改时 update 请求不携带密码字段，Rust 侧 `None` = 保留原值。

**Tech Stack:** Rust（rusqlite, tauri commands）、React 18 + TypeScript、Zustand

**关键现状：**
- `UpdateLlmConfigInput.api_key: Option<String>` — Rust 已实现：`None` 保留原值，`Some("")` 清空（需在前端保证不发空串）
- `UpdateConnectionRequest.password: Option<String>` — Rust 已实现：`None` 或空串均保留原值
- `list_llm_configs` 目前调用 `decrypt_llm_config`，将明文 api_key 返回前端 — **主要修复点**

---

## Task 1: 移除 page-agent

**Files:**
- Delete: `src/hooks/usePageAgent.ts`
- Modify: `src/components/Assistant/index.tsx`
- Modify: `package.json` / `package-lock.json`（npm uninstall）

### Step 1: 卸载 npm 包

```bash
npm uninstall page-agent
```

期望：`package.json` 的 `dependencies` 中不再有 `page-agent`。

### Step 2: 删除 usePageAgent.ts

```bash
rm src/hooks/usePageAgent.ts
```

### Step 3: 更新 Assistant/index.tsx

移除以下两处：

```typescript
// 删除这行 import：
import { usePageAgent } from '../../hooks/usePageAgent';

// 删除组件函数体内这行调用：
usePageAgent();
```

### Step 4: TypeScript 类型检查

```bash
npx tsc --noEmit
```

期望：无错误（page-agent 的类型声明若残留在 `src/types/index.ts` 也一并删除）

### Step 5: Commit

```bash
git add -A
git commit -m "chore: remove page-agent integration"
```

---

## Task 2: Rust — list_llm_configs 遮蔽 api_key

**Files:**
- Modify: `src-tauri/src/commands.rs`

**思路：** 在 command 层将 `api_key` 替换为空串后返回，Rust 内部 `decrypt_llm_config` 不变（`build_llm_client` 等内部调用仍拿完整 key）。

### Step 1: 修改 `list_llm_configs` command

在 `src-tauri/src/commands.rs` 找到（约第 180 行）：

```rust
#[tauri::command]
pub async fn list_llm_configs() -> AppResult<Vec<crate::db::models::LlmConfig>> {
    crate::db::list_llm_configs()
}
```

替换为：

```rust
#[tauri::command]
pub async fn list_llm_configs() -> AppResult<Vec<crate::db::models::LlmConfig>> {
    let configs = crate::db::list_llm_configs()?;
    // api_key 仅在 Rust 内部使用，永不暴露到前端
    Ok(configs.into_iter().map(|mut c| { c.api_key = String::new(); c }).collect())
}
```

### Step 2: cargo check

```bash
cd src-tauri && cargo check
```

期望：无错误

### Step 3: Commit

```bash
git add src-tauri/src/commands.rs
git commit -m "fix(security): mask api_key in list_llm_configs response"
```

---

## Task 3: Rust — 新增 get_llm_config_key 命令

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

### Step 1: 在 commands.rs 末尾的 LLM 配置区追加命令

在 `list_llm_configs` 下方追加：

```rust
/// 返回指定 LLM 配置的明文 API Key（仅供编辑弹窗"小眼睛"功能使用）
#[tauri::command]
pub async fn get_llm_config_key(id: i64) -> AppResult<String> {
    let configs = crate::db::list_llm_configs()?;
    configs.into_iter()
        .find(|c| c.id == id)
        .map(|c| c.api_key)
        .ok_or_else(|| crate::AppError::Other(format!("LlmConfig {} not found", id)))
}
```

### Step 2: 在 lib.rs 的 generate_handler! 中注册

打开 `src-tauri/src/lib.rs`，找到 `generate_handler!` 宏，在 `list_llm_configs` 同区域追加 `get_llm_config_key`。

### Step 3: cargo check

```bash
cd src-tauri && cargo check
```

期望：无错误

### Step 4: Commit

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(security): add get_llm_config_key command for edit-mode reveal"
```

---

## Task 4: Rust — 新增 get_connection_password 命令

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/db/mod.rs`

### Step 1: 在 db/mod.rs 添加 get_connection_password 函数

在 `update_connection` 函数下方追加：

```rust
/// 返回指定连接的明文密码（仅供编辑弹窗"小眼睛"功能使用）
pub fn get_connection_password(id: i64) -> AppResult<String> {
    let conn = get().lock().unwrap();
    let enc: Option<String> = conn.query_row(
        "SELECT password_enc FROM connections WHERE id = ?1",
        [id],
        |row| row.get(0),
    ).optional()?.flatten();
    match enc {
        Some(e) if !e.is_empty() => Ok(crate::crypto::decrypt(&e)?),
        _ => Ok(String::new()),
    }
}
```

### Step 2: 在 commands.rs 连接管理区追加命令

在 `update_connection` command 下方追加：

```rust
/// 返回指定连接的明文密码（仅供编辑弹窗"小眼睛"功能使用）
#[tauri::command]
pub async fn get_connection_password(id: i64) -> AppResult<String> {
    crate::db::get_connection_password(id)
}
```

### Step 3: 在 lib.rs 的 generate_handler! 中注册 get_connection_password

### Step 4: cargo check

```bash
cd src-tauri && cargo check
```

### Step 5: Commit

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/db/mod.rs
git commit -m "feat(security): add get_connection_password command for edit-mode reveal"
```

---

## Task 5: 前端 — LlmSettings 编辑弹窗改造

**Files:**
- Modify: `src/components/Settings/LlmSettings.tsx`

**改造目标：**
- 编辑时 `api_key` 字段默认为空（不从 `editTarget.api_key` 填充，因为现在永远是 `""`）
- 追踪 `apiKeyDirty`：用户在字段中输入过任何内容才视为已修改
- 小眼睛按钮：调用 `get_llm_config_key(id)`，将真实 key 临时显示在字段中（同时设置 `apiKeyDirty = true`）
- 测试连通性时：若 `apiKeyDirty = false`，先静默获取真实 key 用于测试（不写入 form state）
- 保存时：若 `apiKeyDirty = false`，`UpdateLlmConfigInput.api_key` 传 `undefined`（Rust 侧 `None` = 保留原值）

### Step 1: 修改 ConfigFormDialog，增加编辑模式 props

在 `ConfigFormDialogProps` 中新增：

```typescript
interface ConfigFormDialogProps {
  title: string;
  initial: CreateLlmConfigInput;
  onSave: (input: CreateLlmConfigInput, effectiveTestStatus: EffectiveTestStatus, apiKeyDirty: boolean) => Promise<void>;
  onCancel: () => void;
  editId?: number;   // 编辑模式时传入，用于 get_llm_config_key 和 get_connection_password
}
```

### Step 2: 在 ConfigFormDialog 函数体内添加 isDirty 状态

在 `const [successSnapshot, setSuccessSnapshot] = useState` 之后追加：

```typescript
// 编辑模式：追踪 api_key 是否被用户修改过
const [apiKeyDirty, setApiKeyDirty] = useState(false);
```

### Step 3: 修改 api_key 输入框的 onChange，设置 isDirty

找到 PasswordInput 的 onChange：
```typescript
onChange={(v) => setForm((f) => ({ ...f, api_key: v }))}
```
替换为：
```typescript
onChange={(v) => {
  setForm((f) => ({ ...f, api_key: v }));
  setApiKeyDirty(true);
}}
```

### Step 4: 在 PasswordInput 旁边添加"获取当前 Key"按钮（仅编辑模式）

在 `{/* API Key */}` 区块内，`PasswordInput` 组件外包一层 div，并在右侧加按钮：

```typescript
{/* API Key */}
<div>
  <label className={labelClass}>{t('llmSettings.apiKey')}</label>
  <div className="flex items-center gap-2">
    <PasswordInput
      className={inputClass}
      value={form.api_key}
      onChange={(v) => {
        setForm((f) => ({ ...f, api_key: v }));
        setApiKeyDirty(true);
      }}
      placeholder={props.editId ? t('llmSettings.apiKeyPlaceholder') : 'sk-...'}
    />
    {props.editId && !apiKeyDirty && (
      <button
        type="button"
        onClick={async () => {
          try {
            const key = await invoke<string>('get_llm_config_key', { id: props.editId });
            setForm((f) => ({ ...f, api_key: key }));
            setApiKeyDirty(true);
          } catch {}
        }}
        className="text-xs px-2 py-1.5 border border-[#253347] text-[#7a9bb8] hover:text-[#c8daea] rounded whitespace-nowrap"
        title={t('llmSettings.revealKey')}
      >
        {t('llmSettings.revealKey')}
      </button>
    )}
  </div>
</div>
```

### Step 5: 修改 handleTest — 编辑模式下自动获取真实 key

找到 `const handleTest = async () => {` 函数，在 `const tempInput: CreateLlmConfigInput = {` 之前添加：

```typescript
// 编辑模式且未修改 api_key 时，临时获取真实 key 用于测试
let effectiveApiKey = form.api_key;
if (props.editId && !apiKeyDirty) {
  try {
    effectiveApiKey = await invoke<string>('get_llm_config_key', { id: props.editId });
  } catch {}
}
```

将 `tempInput` 的 `api_key` 改为：

```typescript
const tempInput: CreateLlmConfigInput = {
  ...form,
  api_key: effectiveApiKey,
  name: form.name || `${form.model} · ${form.api_type}`,
};
```

### Step 6: 修改 handleSave — 传入 apiKeyDirty

```typescript
const handleSave = async () => {
  setSaving(true);
  try {
    await onSave(form, effectiveTestStatus, apiKeyDirty);
  } finally {
    setSaving(false);
  }
};
```

### Step 7: 修改 LlmSettingsPanel.handleUpdate — 编辑时使用 UpdateLlmConfigInput

找到 `handleUpdate` 函数，替换为：

```typescript
const handleUpdate = async (input: CreateLlmConfigInput, effectiveTestStatus: EffectiveTestStatus, apiKeyDirty: boolean) => {
  if (!editTarget) return;
  const updateInput = {
    name: input.name,
    api_key: apiKeyDirty ? input.api_key : undefined,  // 未修改 → undefined → Rust None → 保留原值
    base_url: input.base_url,
    model: input.model,
    api_type: input.api_type,
    preset: input.preset,
  };
  await invoke('update_llm_config', { id: editTarget.id, input: updateInput });
  if (effectiveTestStatus !== null) {
    await invoke('set_llm_config_test_status', { id: editTarget.id, status: effectiveTestStatus, error: null });
  }
  await loadConfigs();
  setEditTarget(null);
};
```

### Step 8: 更新编辑弹窗调用处，传入 editId

找到 `{editTarget && (` 区块的 `ConfigFormDialog`，修改：

```typescript
{editTarget && (
  <ConfigFormDialog
    title={t('llmSettings.editConfigTitle')}
    initial={{
      name: editTarget.name,
      api_key: '',            // 永远以空串打开，不从 store 填充（store 中也是空串）
      base_url: editTarget.base_url,
      model: editTarget.model,
      api_type: editTarget.api_type,
      preset: editTarget.preset,
    }}
    editId={editTarget.id}   // ← 新增
    onSave={handleUpdate}
    onCancel={() => setEditTarget(null)}
  />
)}
```

### Step 9: 添加 i18n key（如果项目使用 i18next）

在各语言文件中添加：
```json
"apiKeyPlaceholder": "未修改则保留原密钥",
"revealKey": "查看当前密钥"
```

若不用 i18n，直接用中文字符串。

### Step 10: TypeScript 类型检查

```bash
npx tsc --noEmit
```

### Step 11: Commit

```bash
git add src/components/Settings/LlmSettings.tsx
git commit -m "feat(security): LlmSettings edit — isDirty + reveal key, api_key never pre-filled"
```

---

## Task 6: 前端 — ConnectionModal 编辑模式添加查看密码按钮

**Files:**
- Modify: `src/components/ConnectionModal/index.tsx`

**现状分析：**
- `form.password` 初始值为 `''`，Rust 侧 `update_connection` 对空串和 `None` 统一处理为"保留原值" ✓
- 缺少：用户无法查看当前密码（需要小眼睛按钮）

### Step 1: 添加 revealedPassword 状态

在 `const [saving, setSaving] = useState(false);` 后追加：

```typescript
const [revealedPassword, setRevealedPassword] = useState<string | null>(null);
```

### Step 2: 找到密码字段 PasswordInput，添加查看按钮

在 `src/components/ConnectionModal/index.tsx` 中找到密码 `PasswordInput`，外包 div 并添加按钮：

```typescript
<div className="flex items-center gap-2">
  <PasswordInput
    value={form.password ?? ''}
    onChange={(v) => setForm((f) => ({ ...f, password: v }))}
    placeholder={isEdit ? '未修改则保留原密码' : '数据库密码'}
    className="flex-1 bg-[#111827] border border-[#1e2d42] rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#009e84]"
  />
  {isEdit && connection && (
    <button
      type="button"
      onClick={async () => {
        try {
          const pwd = await invoke<string>('get_connection_password', { id: connection.id });
          setRevealedPassword(pwd);
          setForm((f) => ({ ...f, password: pwd }));
        } catch {}
      }}
      className="text-xs px-2 py-1.5 border border-[#1e2d42] text-[#7a9bb8] hover:text-[#c8daea] rounded whitespace-nowrap"
    >
      查看密码
    </button>
  )}
</div>
```

> 注意：点击"查看密码"会将密码填入 form，后续保存时会发送该值。若用户只想查看不想修改，可在确认后清空字段（UX 简化：填入即视为修改）。

### Step 3: TypeScript 类型检查

```bash
npx tsc --noEmit
```

### Step 4: Commit

```bash
git add src/components/ConnectionModal/index.tsx
git commit -m "feat(security): ConnectionModal edit — add reveal password button"
```

---

## Task 7: 文档同步

**Files:**
- Modify: `docs/superpowers/plans/2026-03-12-ai-agent-sql-chat.md`
- Modify: `docs/PLANS.md`

### Step 1: 标注 ai-agent-sql-chat.md 中废弃的 Chunk 3

在 `## Chunk 3: Page Agent 真实集成` 标题下方添加：

```markdown
> ⚠️ **[已废弃 2026-03-12]** page-agent 集成已移除。原因：
> 1. page-agent 自带独立 UI 面板，与 Assistant 聊天框完全脱节
> 2. 前端直连 LLM 需持有 API Key，违反 SECURITY.md
>
> 替代方案：见 `docs/plans/2026-03-12-agent-tool-catalog-design.md`
> — Phase 2 将实现前端 Agent Loop（工具编排）+ Rust LLM 网关（持有密钥）
```

### Step 2: 更新 docs/PLANS.md

在当前状态区域更新：
- 标注 Phase 1（移除 page-agent + 安全修复）为当前执行中
- 链接设计文档 `2026-03-12-agent-tool-catalog-design.md`

### Step 3: Commit

```bash
git add docs/superpowers/plans/2026-03-12-ai-agent-sql-chat.md docs/PLANS.md
git commit -m "docs: mark page-agent chunk as deprecated, link new tool-catalog design"
```

---

## 验收标准

- [ ] `npm test` — sqlParser 单元测试全部通过（不受本次改动影响）
- [ ] `npx tsc --noEmit` — 无 TypeScript 错误
- [ ] `cd src-tauri && cargo check` — 无 Rust 编译错误
- [ ] `list_llm_configs` 返回的所有 config 中 `api_key === ""`
- [ ] 编辑 LLM 配置，不修改密钥，保存后密钥不变（Rust 保留原加密值）
- [ ] 编辑 LLM 配置，点"查看当前密钥"，能看到真实 key
- [ ] 编辑 LLM 配置，修改密钥后保存，新密钥生效
- [ ] 编辑 LLM 配置，多次报错重试，未修改密钥的情况下密钥不受影响
- [ ] 编辑数据库连接，点"查看密码"，能看到真实密码
- [ ] Assistant 面板无 page-agent 相关代码，加载无报错
