# ConnectionDbSelector 公共组件设计

**日期：** 2026-04-10  
**状态：** 已批准

## 背景

迁移中心 `ConfigTab` 和知识图谱 `GraphExplorer` 均有独立的"连接下拉 + 数据库下拉"选择逻辑，代码重复，且接口不统一（前者部分场景调用 `list_databases`，后者调用 `list_databases_for_metrics`）。本次提取公共组件，统一接口，消除重复。

## 目标

1. 新增 `ConnectionDbSelector` 公共组件
2. `ConfigTab`（源端 + 目标端）和 `GraphExplorer` 均使用该组件
3. 数据库列表统一调用 `list_databases_for_metrics`（过滤系统库，适合迁移/图谱场景）
4. 连接列表统一通过 `useConnectionStore` 获取，不再各自 invoke

## 组件接口

```typescript
// src/components/common/ConnectionDbSelector.tsx

interface ConnectionDbSelectorProps {
  connectionId: number               // 当前连接 ID，0 = 未选
  database: string                   // 当前数据库名，'' = 未选
  onConnectionChange: (connectionId: number) => void
  onDatabaseChange: (database: string) => void
  connectionPlaceholder?: string     // 默认由调用方通过 i18n 传入
  databasePlaceholder?: string       // 默认由调用方通过 i18n 传入
  disabled?: boolean
  className?: string
}
```

## 内部行为

- 连接列表：从 `useConnectionStore` 读取；若尚未加载则自动触发 `loadConnections()`
- 数据库列表：连接 ID 变化时调用 `invoke('list_databases_for_metrics', { connectionId })`，带 loading 态
- 连接变化时组件**只**触发 `onConnectionChange`，**不**自动调用 `onDatabaseChange`；清空数据库由父组件在 `onConnectionChange` 回调中处理
- 数据库下拉在连接未选或加载中时禁用
- 加载失败时在数据库下拉区域显示错误文本（小字，不阻断流程）

## 文件变更

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/components/common/ConnectionDbSelector.tsx` | 新增 | 公共组件 |
| `src/components/MigrationJobTab/ConfigTab.tsx` | 修改 | 源端 + 目标端各替换一个组件，移除冗余 state |
| `src/components/GraphExplorer/index.tsx` | 修改 | 替换内部连接/数据库选择逻辑（约 lines 221–267） |

## ConfigTab 状态简化

移除以下 state：
- `connections`（改由 `useConnectionStore` 提供）
- `sourceDatabases` / `dbsLoading`（移入组件内部）
- `targetDatabases` / `targetDbsLoading`（移入组件内部）

保留不变：
- `sourceTables` / `targetTables` 及其加载逻辑（表级别，不属于本组件范畴）

## 测试要点

1. ConfigTab 源端：切换连接 → 数据库列表刷新，已选数据库清空，表列表清空
2. ConfigTab 目标端：切换连接 → 数据库列表刷新，已选数据库清空
3. ConfigTab 源端 / 目标端互相独立，互不影响
4. GraphExplorer：切换连接/数据库后图谱数据正确重载，行为与改造前一致
5. 边界：connectionId = 0 时数据库下拉禁用
6. 边界：`list_databases_for_metrics` 调用失败时显示错误，不崩溃

## 不在范围内

- Rust 后端无需改动
- `list_databases` 接口保留（其他场景可能仍需要）
- GraphExplorer 其他内部状态（typeFilter、searchQuery 等）不变
