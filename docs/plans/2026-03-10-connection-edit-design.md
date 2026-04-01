<!-- STATUS: ✅ 已实现 -->
# 数据库连接编辑功能设计文档

**日期**：2026-03-10
**状态**：已批准

---

## 需求

左侧连接列表支持右键菜单，提供「连接 / 编辑 / 删除」操作。

---

## 交互设计

右键点击连接名称，弹出浮动菜单：

```
┌─────────────────┐
│  连接            │  ← 激活/切换到该连接
│  编辑            │  ← 打开编辑弹窗
│  ──────────────  │
│  删除            │  ← 红色，点击后二次确认
└─────────────────┘
```

编辑弹窗复用 ConnectionModal：
- 预填当前连接所有字段（名称、驱动、主机、端口、数据库名、用户名）
- 密码字段留空，placeholder：「留空则不修改密码」
- 标题改为「编辑连接」，保存按钮文字改为「保存修改」

---

## 技术方案

### 后端（Rust）

新增 `update_connection` Tauri 命令：

```rust
#[tauri::command]
pub async fn update_connection(id: i64, req: UpdateConnectionRequest) -> AppResult<Connection>
```

`UpdateConnectionRequest`：与 `CreateConnectionRequest` 相同，password 改为 `Option<String>`（为 None 时保留原密码）。

`db::update_connection()` 执行：
```sql
UPDATE connections SET name=?, driver=?, host=?, port=?, database_name=?,
  username=?, password=?, updated_at=? WHERE id=?
```
password 为 None 时跳过 password 字段更新。

### 前端 Store

`connectionStore` 新增：
```typescript
updateConnection: (id: number, req: CreateConnectionRequest) => Promise<Connection>
```
成功后替换 connections 数组中对应项。

### 前端组件

**ConnectionModal**：新增可选 prop `connection?: Connection`：
- 有值 → 编辑模式（预填表单，调用 updateConnection）
- 无值 → 新建模式（现有逻辑不变）

**Explorer**：
- 每个连接 div 加 `onContextMenu` 事件
- 菜单状态：`{ connId, x, y } | null`
- 点击外部关闭菜单
- 删除操作：弹出 `window.confirm()` 二次确认

---

## 涉及文件

| 文件 | 操作 |
|------|------|
| `src-tauri/src/db/mod.rs` | 新增 `update_connection()` |
| `src-tauri/src/commands.rs` | 新增 `update_connection` 命令 + 注册 |
| `src-tauri/src/lib.rs` | generate_handler 注册新命令 |
| `src/store/connectionStore.ts` | 新增 `updateConnection` action |
| `src/components/ConnectionModal/index.tsx` | 支持 edit 模式 |
| `src/components/Explorer/index.tsx` | 右键菜单 + 删除确认 |
