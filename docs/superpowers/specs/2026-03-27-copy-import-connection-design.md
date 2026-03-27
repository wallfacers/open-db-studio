# 复制 / 导入连接信息 设计文档

**日期**: 2026-03-27
**状态**: 已批准

---

## 背景

用户在多环境（开发/测试/生产）或多机器间共享数据库连接配置时，需要手动重新填写所有字段，体验繁琐。本功能通过剪贴板实现连接信息的一键复制与快速导入。

---

## 前提确认

`@tauri-apps/plugin-clipboard-manager` 已在 `package.json`（`^2.3.2`）和 `src-tauri/Cargo.toml` 中注册，`writeText` / `readText` 均可直接使用，无需额外安装。

---

## 功能描述

### 功能一：复制连接信息

在连接节点右键菜单新增「复制连接信息」菜单项，点击后将该连接的完整配置（含解密密码）写入剪贴板。

### 功能二：新建连接时自动检测并导入

打开新建连接对话框时，自动读取剪贴板内容，若检测到合法连接信息则展示导入提示横幅，用户一键填充表单。

---

## 剪贴板数据格式

采用带识别标记的 JSON 格式，**仅包含可被对端重用的配置字段，元数据字段（`id`、`group_id`、`sort_order`、`created_at`、`updated_at`）全部排除**：

```json
{
  "_odb": 1,
  "driver": "mysql",
  "name": "prod-mysql",
  "host": "192.168.1.1",
  "port": 3306,
  "database_name": "shop",
  "username": "root",
  "password": "plaintext_password",
  "file_path": null,
  "extra_params": null
}
```

- `_odb: 1` 作为应用识别标记，防止误判普通 JSON
- `driver` 为必要校验字段（见功能二校验规则）
- `name` 为可选字段，缺失时导入横幅显示「未命名」，不阻断流程
- 密码为明文（用户已知晓安全风险并主动选择包含密码）
- `group_id` 不携带，分组由用户导入后自行选择
- `sort_order`、`created_at`、`updated_at` 为系统元数据，不携带

---

## 功能一详细设计

### 菜单项位置

connection 节点右键菜单，插入在「编辑连接」之后，「删除连接」之前：

```
连接 / 断开连接
新建查询
刷新
移动到分组
新建数据库
编辑连接
复制连接信息    ← 新增
删除连接
```

### 执行流程

1. 用户点击「复制连接信息」
2. 从 `useConnectionStore().connections` 按 `connectionId` 查找对应 `Connection` 对象
3. 调用 `invoke('get_connection_password', { id: connectionId })` 取回解密后的明文密码
4. 组装 JSON：`{ _odb: 1, driver, name, host, port, database_name, username, password, file_path, extra_params }`
5. 调用 `writeText(JSON.stringify(payload))`（`@tauri-apps/plugin-clipboard-manager`）
6. 成功：toast「连接信息已复制到剪贴板」（i18n key：`contextMenu.copyConnectionInfoSuccess`）
7. 失败（步骤 3 或步骤 5 抛异常）：toast「复制失败，请重试」（i18n key：`contextMenu.copyConnectionInfoError`）

### ContextMenu 接口变更

遵循现有 optional 惯例（与 `onOpenMetricList?`、`onOpenMetric?` 保持一致）：

```typescript
onCopyConnectionInfo?: () => void;
```

在 `case 'connection'` 菜单项数组中插入（位置：`editConnection` 项之后，`deleteConnection` 项之前）：

```typescript
{
  label: t('contextMenu.copyConnectionInfo'),
  icon: Copy,
  onClick: onCopyConnectionInfo || (() => {}),
  disabled: !onCopyConnectionInfo,
}
```

### 涉及文件

| 文件 | 变更内容 |
|------|---------|
| `src/components/Explorer/ContextMenu.tsx` | `ContextMenuProps` 新增 `onCopyConnectionInfo?: () => void`；connection case 增加菜单项；新增 Copy 图标导入 |
| `src/components/Explorer/DBTree.tsx` | 实现 `handleCopyConnectionInfo(connectionId)`：从 store 查连接 → invoke 取密码 → 组装 JSON → writeText → toast；在 `<ContextMenu>` 处补传 `onCopyConnectionInfo` |
| `src/i18n/locales/zh.json` | 新增 3 个扁平键（见 i18n 键清单） |
| `src/i18n/locales/en.json` | 新增对应英文翻译 |

---

## 功能二详细设计

### 触发条件

- 仅在**新建模式**下触发，即 `!connection`（`isEdit === false`）时
- 对话框 mount 时执行一次性检测（`useEffect` deps: `[]`）

### 剪贴板读取 API

```typescript
import { readText } from '@tauri-apps/plugin-clipboard-manager';
```

### 校验规则（顺序执行，任一失败则静默忽略，整个 try/catch 包裹）

1. `readText()` 调用成功（不抛异常）
2. 内容可被 `JSON.parse` 解析，且结果为对象
3. `result._odb === 1`
4. `typeof result.driver === 'string' && result.driver.length > 0`
5. `DRIVERS.some(d => d.value === result.driver)`（防止未知驱动导致表单异常）

### 导入时的表单填充

直接 `setForm` 批量更新，**不调用** `handleDriverChange`（因为导入的 port 是真实生产配置，不应被默认端口覆盖）：

```typescript
setForm(f => ({
  ...f,
  driver:        conn.driver,
  name:          conn.name   ?? f.name,
  host:          conn.host   ?? '',
  port:          conn.port   ?? DRIVERS.find(d => d.value === conn.driver)?.defaultPort ?? undefined,
  database_name: conn.database_name ?? '',
  username:      conn.username ?? '',
  password:      conn.password ?? '',
  file_path:     conn.file_path ?? '',
  extra_params:  conn.extra_params ?? '',
}));
```

`port` 回退规则：剪贴板有值 → 用剪贴板值；为 null → 回退到 `DRIVERS.defaultPort`；`defaultPort` 也为 null（SQLite）→ `undefined`。

### `extra_params` 处理

写入表单 state，但 `ConnectionModal` 当前 UI 无可见输入项，保存时值会被携带提交，不会丢失。此为已知限制，不在本次范围内处理。

### SQLite 连接说明

当 `driver === 'sqlite'` 时，`file_path` 导入后可能为 null 或在目标机器路径不存在。正常导入，用户需在表单中手动选择文件，不阻断流程。

### 提示横幅 UI

对话框顶部（标题下方、表单上方）：

```
┌──────────────────────────────────────────────────────────┐
│ 🔗 检测到连接信息（prod-mysql · MySQL）   [导入]   [✕]   │
└──────────────────────────────────────────────────────────┘
```

**样式规格：**
- 容器：`bg-[#0d2137] border border-[#00c9a7]/40 rounded px-3 py-2 flex items-center gap-2 mb-4 text-sm`
- 文字：`text-[#b5cfe8]`，连接名 + 驱动名用 `text-[#c8daea] font-medium` 强调
- 分隔符 ` · ` 硬编码，无需 i18n
- 「导入」按钮：`text-[#00c9a7] hover:underline cursor-pointer ml-auto`
- 「✕」图标：lucide `X` size=14，`text-[#7a9bb8] hover:text-[#c8daea] cursor-pointer`，`aria-label={t('connectionModal.importBannerClose')}`

**字段来源：**
- 连接名：`clipboardConn.name || t('connectionModal.importBannerUnnamed')`
- 驱动名：`DRIVERS.find(d => d.value === clipboardConn.driver)?.label ?? clipboardConn.driver`

### 涉及文件

| 文件 | 变更内容 |
|------|---------|
| `src/components/ConnectionModal/index.tsx` | 新增 `clipboardConn` state；新增 `useEffect` 检测剪贴板；新增横幅 JSX；导入 `readText` |
| `src/i18n/locales/zh.json` | 新增 `connectionModal.importBanner*` 相关翻译键 |
| `src/i18n/locales/en.json` | 同上英文翻译 |

---

## 错误处理

| 场景 | 处理方式 |
|------|---------|
| `invoke('get_connection_password')` 失败 | toast 错误（`contextMenu.copyConnectionInfoError`），不写剪贴板 |
| `writeText` 失败 | toast 错误（`contextMenu.copyConnectionInfoError`） |
| `readText` 失败 | 静默忽略 |
| 剪贴板内容非合法 JSON | 静默忽略（try/catch） |
| JSON 无 `_odb` 标记、`driver` 为空或不在 DRIVERS 列表 | 静默忽略 |
| `name` 字段缺失 | 横幅显示「未命名」，不阻断导入流程 |
| `driver === 'sqlite'` 且 `file_path` 为 null | 正常导入，用户手动选择文件 |

---

## i18n 键清单（扁平键，与现有 contextMenu 风格一致）

### zh.json 新增

```
contextMenu.copyConnectionInfo      → "复制连接信息"
contextMenu.copyConnectionInfoSuccess → "连接信息已复制到剪贴板"
contextMenu.copyConnectionInfoError   → "复制失败，请重试"
connectionModal.importBannerTitle   → "检测到连接信息"
connectionModal.importBannerUnnamed → "未命名"
connectionModal.importBannerImport  → "导入"
connectionModal.importBannerClose   → "关闭"
```

### en.json 新增

```
contextMenu.copyConnectionInfo      → "Copy Connection Info"
contextMenu.copyConnectionInfoSuccess → "Connection info copied to clipboard"
contextMenu.copyConnectionInfoError   → "Copy failed, please try again"
connectionModal.importBannerTitle   → "Connection info detected"
connectionModal.importBannerUnnamed → "Unnamed"
connectionModal.importBannerImport  → "Import"
connectionModal.importBannerClose   → "Close"
```

---

## 安全说明

- 密码以**明文**写入系统剪贴板，用户已知晓此风险并主动选择
- 剪贴板内容不由应用持久化，由操作系统管理
- 本功能不改变现有密码存储机制（Rust 层 AES-256 加密）

---

## 不在范围内

- 跨应用（非 open-db-studio）的连接格式兼容
- 连接信息的文件导出/导入
- 批量复制多个连接
- `extra_params` 的可视化编辑
