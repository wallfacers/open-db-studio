# ActivityBar 导航

> **模块类型**：核心功能
> **首次发布**：MVP
> **状态**：✅ 已完成

---

## 用户指南

### 功能概述

ActivityBar 是 Open DB Studio 的左侧导航栏，采用 VSCode 风格设计。提供数据库模式、指标模式、图谱模式三种工作模式切换，以及任务中心、设置等快捷入口。

### 快速入门

**1. 切换工作模式**
- 点击 ActivityBar 图标切换：
  - 🔌 DB 模式：连接管理、SQL 编辑器
  - 📊 指标模式：业务指标浏览
  - 🧠 图谱模式：知识图谱探索

**2. 打开 AI 助手**
- 点击右侧边缘浮动 Tab
- 或按快捷键 `Ctrl+Shift+A`

**3. 进入设置**
- 点击 ActivityBar 底部 ⚙️ 图标
- 配置 AI 模型、主题、快捷键等

### 操作说明

**模式切换**
- DB 模式（🔌）：
  - 连接列表：查看、管理数据库连接
  - SQL 编辑器：编写、执行 SQL
  - 对象浏览器：展开查看表、视图、索引等

- 指标模式（📊）：
  - 指标树：浏览原子指标和复合指标
  - AI 生成：扫描 Schema 生成指标
  - 审核列表：待审核的指标草稿

- 图谱模式（🧠）：
  - 图谱画布：可视化 Schema 关系
  - 搜索面板：查找表、别名、指标
  - 路径面板：JOIN 路径探索

**底部入口**
- Tasks（任务中心）：查看导入导出任务进度
- Settings（设置）：应用配置

**浮动 AI 助手 Tab**
- 位置：右边缘浮动按钮
- 展开：点击打开 AI 助手面板
- 拖拽：可调整面板位置
- 快捷键：`Ctrl+Shift+A`

**Unified Tab 内容区**
- 三种模式共用右侧内容区
- 多项目以 Tab 形式展示
- 支持拖拽排序、关闭 Tab

### 常见问题

**Q: 模式切换后数据不保留？**
A: 模式切换时当前工作区状态会保存，切换回来可恢复。

**Q: 如何固定 AI 助手面板？**
A: 拖拽面板到侧边可固定，再次拖拽可恢复浮动。

**Q: Tab 太多如何管理？**
A: 右键 Tab 可关闭、关闭其他、关闭右侧等批量操作。

---

## 开发者指南

### 架构设计

ActivityBar 架构：
- **状态管理**：activeActivity 控制当前模式
- **Unified Tab**：多模式共用 Tab 内容区
- **Zustand Store**：跨组件状态同步
- **浮动面板**：AssistantToggleTab 独立实现

### 数据流

```
点击 ActivityBar → setActiveActivity → 切换侧边栏内容 → Unified Tab 展示对应内容
```

### 状态结构

**activeActivity**
```typescript
type Activity = 'connection' | 'metrics' | 'graph';
const activeActivity: Activity = 'connection'; // 当前激活模式
```

**unified_tabs_state**
```typescript
interface UnifiedTabsState {
  tabs: Tab[];
  activeTabId: string | null;
}

interface Tab {
  id: string;
  type: 'connection' | 'metrics' | 'graph' | 'sql' | 'er';
  title: string;
  data: any;
}
```

### 组件结构

**ActivityBar**
```
ActivityBar/
├── ActivityBar.tsx          # 主容器
├── ActivityButton.tsx       # 模式切换按钮
├── ConnectionPanel.tsx      # DB 模式侧边栏
├── MetricsPanel.tsx         # 指标模式侧边栏
├── GraphPanel.tsx           # 图谱模式侧边栏
└── BottomActions.tsx        # 底部入口（Tasks/Settings）
```

**AssistantToggleTab**
```
AssistantToggleTab/
├── AssistantToggleTab.tsx   # 浮动按钮
├── AssistantPanel.tsx       # AI 助手面板
└── useAssistantPosition.ts  # 位置拖拽逻辑
```

### API 接口

ActivityBar 本身不提供 Tauri 命令，依赖各模块 API。

### 扩展方式

**添加新模式**
1. 扩展 `Activity` 类型
2. 创建新 Panel 组件
3. 在 ActivityBar 注册新按钮
4. 更新 Unified Tab 处理逻辑

**自定义 ActivityBar 样式**
修改 `src/components/ActivityBar/ActivityBar.tsx`：
- 调整图标大小、间距
- 自定义激活态样式
- 添加徽章（未读消息数等）

### 相关文档

- 设计文档：无独立设计文档
- 前端规范：[docs/FRONTEND.md](../../FRONTEND.md)

---

## 文件索引

| 目录/文件 | 说明 |
|----------|------|
| `src/components/ActivityBar/` | ActivityBar 组件 |
| `src/components/AssistantToggleTab/` | 浮动 AI Tab |
| `src/App.tsx` | activeActivity + unified_tabs_state |
| `src/store/appStore.ts` | Zustand 状态管理 |
