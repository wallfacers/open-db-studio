# 业务指标层

> **模块类型**：AI 能力
> **首次发布**：V2
> **状态**：✅ 已完成

---

## 用户指南

### 功能概述

业务指标层提供语义化指标管理能力，支持定义原子指标和复合指标。AI 可扫描 Schema 自动生成指标草稿，人工审核后入库。提问时自动注入相关指标定义，提升 AI 生成 SQL 的准确性。

### 快速入门

**1. AI 生成指标**
- 切换到指标模式（ActivityBar 📊 图标）
- 点击「AI 生成指标」
- 选择目标表，AI 扫描 Schema 和数据样本
- 生成指标草稿列表

**2. 审核指标**
- 查看草稿指标详情
- 确认无误点击「批准」
- 需要修改点击「拒绝」并说明原因

**3. 使用指标提问**
- 在 AI 助手中提问「查询本月销售额」
- 自动识别并注入相关指标定义
- AI 基于指标定义生成准确 SQL

### 操作说明

**指标定义**
- 原子指标：基于单一表/字段的聚合计算
  - 名称：销售额、用户数等
  - 表/字段：数据来源
  - 聚合：SUM/COUNT/AVG/MAX/MIN
  - 过滤：WHERE 条件
  - 业务含义：指标解释

- 复合指标：基于原子指标的计算
  - 公式：原子指标间的运算
  - 如：客单价 = 销售额 / 订单数

**AI 生成流程**
1. 选择目标数据库和表
2. AI 扫描表结构和数据样本
3. 分析数值型、时间型字段
4. 生成候选指标草稿
5. 人工审核确认入库

**指标树导航**
- 原子指标分组：按业务域分类
- 复合指标分组：展示指标间关系
- 搜索过滤：按名称、表名搜索

**检索增强**
- 提问时自动匹配相关指标
- 注入指标定义到 AI 上下文
- 基于指标生成准确聚合 SQL

### 常见问题

**Q: AI 生成的指标不准确？**
A: 审核时修改业务含义和过滤条件，或拒绝后重新生成。

**Q: 指标如何应用到 SQL？**
A: 提问时使用指标名称（如「查询销售额」），AI 自动引用指标定义。

**Q: 复合指标如何创建？**
A: 先定义原子指标，然后在复合指标中引用并设置计算公式。

---

## 开发者指南

### 架构设计

业务指标层架构：
- **指标定义**：metrics / semantic_aliases 表
- **AI 生成**：Schema 扫描 + 数据采样 + LLM 生成
- **状态流转**：draft → approved/rejected
- **检索增强**：提问时语义匹配注入

### 数据流

```
Schema 扫描 → 数据采样 → LLM 生成 → draft 状态 → 人工审核 → approved
                                              ↓
                                       提问时检索注入
```

### 数据表结构

**metrics**
- `id` - 指标 ID
- `connection_id` - 所属连接
- `name` - 指标名称（唯一）
- `metric_type` - 类型（atomic/composite）
- `table_name` - 来源表
- `column_name` - 来源字段
- `aggregation` - 聚合函数（SUM/COUNT/AVG/MAX/MIN）
- `filter_condition` - 过滤条件 SQL
- `formula` - 复合指标公式
- `description` - 业务含义描述
- `status` - 状态（draft/approved/rejected）
- `created_by` - 创建方式（ai/manual）

**semantic_aliases**
- `id` - 别名 ID
- `connection_id` - 所属连接
- `target_type` - 目标类型（table/column/metric）
- `target_id` - 目标 ID
- `alias` - 别名
- `description` - 描述

### API 接口

**指标 CRUD**
- `metrics_list(connection_id: i64) -> Result<Vec<Metric>, Error>`
- `metrics_create(metric: MetricInput) -> Result<Metric, Error>`
- `metrics_update(id: i64, metric: MetricInput) -> Result<Metric, Error>`
- `metrics_delete(id: i64) -> Result<(), Error>`

**AI 生成**
- `metrics_ai_generate(connection_id: i64, table_names: Vec<String>) -> Result<Vec<MetricDraft>, Error>`
- 扫描指定表生成指标草稿

**审核流程**
- `metrics_approve(id: i64) -> Result<Metric, Error>`
- `metrics_reject(id: i64, reason: String) -> Result<Metric, Error>`

**语义别名**
- `alias_create(alias: AliasInput) -> Result<Alias, Error>`
- `alias_list(target_type: String, target_id: i64) -> Result<Vec<Alias>, Error>`

### 扩展方式

**自定义指标类型**
1. 扩展 `MetricType` enum
2. 在 AI 生成逻辑中添加新类型识别
3. 前端添加类型选择器

**指标检索算法**
修改 `src-tauri/src/metrics/retrieve.rs`：
- 实现语义相似度匹配
- 添加上下文权重计算
- 优化检索结果排序

### 相关文档

- 设计文档：[docs/superpowers/specs/2026-03-16-metrics-tree-redesign.md](./2026-03-16-metrics-tree-redesign.md)

---

## 文件索引

| 目录/文件 | 说明 |
|----------|------|
| `src/components/MetricsExplorer/` | 指标浏览器组件 |
| `src-tauri/src/metrics/` | Rust 指标模块 |
| `src-tauri/src/metrics/crud.rs` | 指标 CRUD 操作 |
| `src-tauri/src/metrics/ai_draft.rs` | AI 生成草稿逻辑 |
| `src-tauri/src/metrics/retrieve.rs` | 检索增强逻辑 |
| `schema/init.sql` | metrics/semantic_aliases 表结构 |
