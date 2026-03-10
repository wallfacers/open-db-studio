# FRONTEND.md — 前端开发规范

## 组件结构

- 每个组件一个目录，入口文件为 `index.tsx`
- 子组件放在同目录（如 `Explorer/TreeItem.tsx`）
- 命名：PascalCase，目录与组件名一致

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
