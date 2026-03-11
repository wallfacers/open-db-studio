# AI 模型配置列表化改造设计

**日期**：2026-03-11
**状态**：已批准
**范围**：LLM 配置管理 — 从单条配置改造为支持 CRUD 的多配置列表

---

## 背景

现有 `LlmSettings` 是单条配置，以 key-value 存储在 SQLite。
目标是支持多条模型配置并存，卡片列表展示，带默认标记与持久化连通性测试状态。

---

## 数据模型

### 新增 SQLite 表 `llm_configs`

```sql
CREATE TABLE llm_configs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  api_key     TEXT NOT NULL DEFAULT '',  -- AES-256 加密存储
  base_url    TEXT NOT NULL,
  model       TEXT NOT NULL,
  api_type    TEXT NOT NULL DEFAULT 'openai',  -- 'openai' | 'anthropic'
  preset      TEXT,                            -- NULL = 自定义
  is_default  INTEGER NOT NULL DEFAULT 0,      -- 1=默认，全局唯一
  test_status TEXT NOT NULL DEFAULT 'untested', -- 'untested'|'testing'|'success'|'fail'
  test_error  TEXT,
  tested_at   TEXT,                            -- ISO 8601
  created_at  TEXT NOT NULL
);
```

### 迁移策略

首次启动时自动将旧 `llm.*` key-value 数据迁移为第一条配置并设为 default，
迁移完成后删除旧 key-value 记录。

### TypeScript 类型

```typescript
export interface LlmConfig {
  id: number;
  name: string;
  api_key: string;
  base_url: string;
  model: string;
  api_type: ApiType;
  preset: string | null;
  is_default: boolean;
  test_status: 'untested' | 'testing' | 'success' | 'fail';
  test_error: string | null;
  tested_at: string | null;
  created_at: string;
}

export interface CreateLlmConfigInput {
  name?: string;       // 为空时自动填充 "{model} · {api_type}"
  api_key: string;
  base_url: string;
  model: string;
  api_type: ApiType;
  preset?: string;
}

export type UpdateLlmConfigInput = Partial<CreateLlmConfigInput>;
```

旧 `LlmSettings` 接口直接删除。

---

## Rust 后端命令

旧命令 `get_llm_settings` / `set_llm_settings` / `test_llm_connection` 直接删除，替换为：

| 命令 | 说明 |
|------|------|
| `list_llm_configs()` | 返回所有配置列表 |
| `create_llm_config(input)` | 新建配置，若是第一条自动设为 default |
| `update_llm_config(id, input)` | 更新配置字段 |
| `delete_llm_config(id)` | 删除配置，若删的是 default 则自动将最早创建的另一条设为 default |
| `set_default_llm_config(id)` | 设为默认（事务：先清全部，再设指定行） |
| `test_llm_config(id)` | 测试连通性，结果持久化写回 test_status/test_error/tested_at |
| `get_default_llm_config()` | 获取当前默认配置，供 AI 功能内部调用 |

### 关键约束

- `is_default` 全局唯一，`set_default_llm_config` 用事务保证
- `test_llm_config` 先写 `test_status='testing'`，异步完成后写结果
- 删除最后一条配置允许执行，AI 功能降级显示"未配置模型"提示

---

## 前端 Store 重构

```typescript
interface AiState {
  // 配置列表
  configs: LlmConfig[];
  loadConfigs: () => Promise<void>;
  createConfig: (input: CreateLlmConfigInput) => Promise<void>;
  updateConfig: (id: number, input: UpdateLlmConfigInput) => Promise<void>;
  deleteConfig: (id: number) => Promise<void>;
  setDefaultConfig: (id: number) => Promise<void>;
  testConfig: (id: number) => Promise<void>;  // 乐观更新 status='testing'

  // AI 面板当前选中的配置（null = 使用 default）
  activeConfigId: number | null;
  setActiveConfigId: (id: number | null) => void;

  // AI 功能（generateSql/explainSql/optimizeSql 等保持不变，内部读 activeConfig）
}
```

旧 `settings` / `loadSettings` / `saveSettings` 字段直接删除。

---

## UI 设计

### 配置列表页（卡片网格）

```
┌─ AI 模型配置 ──────────────────── [+ 新增配置] ┐
│                                                  │
│  ┌──────────────────┐  ┌──────────────────┐     │
│  │ ★ 我的 GPT-4     │  │ 公司 Claude       │     │
│  │ gpt-4o-mini      │  │ claude-3-5-sonnet│     │
│  │ OpenAI 兼容      │  │ Anthropic 兼容   │     │
│  │ ● 连通 2h前      │  │ ○ 未测试         │     │
│  │ [测试][编辑][删] │  │ [设为默认][测试] │     │
│  └──────────────────┘  └──────────────────┘     │
└──────────────────────────────────────────────────┘
```

### 连通性状态指示

| test_status | 图标 | 颜色 |
|-------------|------|------|
| untested | ○ 未测试 | 灰色 |
| testing | ◌ 测试中… | 黄色转圈 |
| success | ● 连通 + tested_at 相对时间 | 绿色 |
| fail | ● 失败 + 错误摘要 | 红色 |

### 新增/编辑配置（模态对话框）

复用现有表单字段：名称（可选）、厂商预设、API 协议、API Key、Base URL、模型。
- 名称为空时自动填充 `{model} · {api_type}`
- 对话框底部"测试连通性"按钮（可跳过直接保存）

### 删除保护

- 删除 default 配置弹出确认，提示自动改为次早配置作为默认
- 最后一条配置也可删除，删后显示空态引导新增

### AI 面板模型选择器

位置：AI 面板 SQL 生成下拉旁边。
默认显示 default 配置名称（`★` 前缀）。
下拉列出全部配置，每项带 test_status 指示灯。
选择后设置 `activeConfigId`，仅影响当前会话，不修改 is_default。
无配置时显示"去配置"链接跳转设置页。

---

## 文件变更清单

| 文件 | 变更类型 |
|------|----------|
| `schema/init.sql` | 新增 `llm_configs` 表 DDL |
| `src-tauri/src/db/` | 新增 llm_configs CRUD 函数 |
| `src-tauri/src/commands.rs` | 替换旧 llm 命令为新 7 个命令 |
| `src-tauri/src/lib.rs` | 更新 `generate_handler![]` 注册 |
| `src/types/index.ts` | 删除 `LlmSettings`，新增 `LlmConfig` 等类型 |
| `src/store/aiStore.ts` | 重构 store，删除旧 settings 逻辑 |
| `src/components/Settings/LlmSettings.tsx` | 重构为卡片列表 + 模态编辑 |
| `src/components/AI/` | AI 面板增加模型选择器 |
