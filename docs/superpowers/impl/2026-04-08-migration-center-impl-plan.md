<!-- STATUS: 🔄 实施中 -->
# 迁移中心实现计划（Rust 原生 ETL）

**日期**: 2026-04-08
**状态**: 实施中
**依赖**: [迁移中心设计规范](../specs/2026-04-07-migration-center-design.md)
**范围**: 11 个任务，覆盖架构、核心引擎、前后端集成

---

## 任务总览

| # | 任务 | 状态 | 预估工时 | 负责人 |
|---|------|------|----------|--------|
| 1 | 架构与依赖配置 | ⬜ | 2h | TBD |
| 2 | 数据源抽象与连接池 | ⬜ | 4h | TBD |
| 3 | Schema 抽取与类型系统 | ⬜ | 6h | TBD |
| 4 | 数据迁移引擎（Pipeline） | ⬜ | 8h | TBD |
| 5 | DDL 转换与执行 | ⬜ | 6h | TBD |
| 6 | 前端 Task 进度组件复用 | ⬜ | 4h | TBD |
| 7 | 迁移中心前端页面 | ⬜ | 6h | TBD |
| 8 | Tauri 命令层开发 | ⬜ | 4h | TBD |
| 9 | 断点续传与恢复机制 | ⬜ | 4h | TBD |
| 10 | 集成测试与性能调优 | ⬜ | 6h | TBD |
| 11 | 文档与示例 | ⬜ | 2h | TBD |

**预估总工时**: 52 小时

---

## 任务 1: 架构与依赖配置

### 目标
初始化迁移中心模块，配置必要的 Rust 依赖。

### 实现步骤

1. **创建模块目录结构**
   ```
   src-tauri/src/migration/
   ├── mod.rs              # 模块入口
   ├── models.rs           # 核心数据结构
   ├── engine/
   │   ├── mod.rs          # 引擎入口
   │   ├── pipeline.rs     # Pipeline 编排
   │   ├── task.rs         # Task 任务定义
   │   └── checkpoint.rs   # 断点续传
   ├── source/
   │   ├── mod.rs          # Source 抽象
   │   ├── mysql.rs        # MySQL 实现
   │   ├── postgres.rs     # PostgreSQL 实现
   │   └── sqlite.rs       # SQLite 实现
   ├── sink/
   │   ├── mod.rs          # Sink 抽象
   │   ├── mysql.rs        # MySQL 实现
   │   ├── postgres.rs     # PostgreSQL 实现
   │   └── sqlite.rs       # SQLite 实现
   ├── transform/
   │   ├── mod.rs          # Transform 抽象
   │   ├── schema.rs       # Schema 转换
   │   ├── type_map.rs     # 类型映射
   │   └── ddl_gen.rs      # DDL 生成
   └── commands.rs         # Tauri 命令
   ```

2. **Cargo.toml 依赖配置**
   ```toml
   [dependencies]
   # 新增依赖
   futures = "0.3"
   pin-project = "1.1"
   crossbeam-channel = "0.5"
   dashmap = "5.5"
   parking_lot = "0.12"
   petgraph = "0.6"
   ```

3. **注册模块**
   - 在 `src-tauri/src/lib.rs` 添加 `pub mod migration;`
   - 在 `commands.rs` 的 `generate_handler![]` 中注册迁移相关命令

### 输出物
- `src-tauri/src/migration/` 目录结构
- 更新的 `Cargo.toml`
- 基础 `mod.rs` 框架

---

## 任务 2: 数据源抽象与连接池

### 目标
构建统一的 Source/Sink trait，复用现有连接池。

### 实现步骤

1. **定义 Source trait**（`src/migration/source/mod.rs`）
   ```rust
   #[async_trait]
   pub trait Source: Send + Sync {
       /// 获取 Schema 信息
       async fn get_schema(&self, table_filter: Option<&[String]>) -> Result<DatabaseSchema>;

       /// 创建数据读取流
       fn read(&self, table: &TableSchema, options: ReadOptions) -> Result<RecordStream>;

       /// 估算总行数
       async fn estimate_count(&self, table: &TableSchema) -> Result<u64>;

       /// 关闭连接
       async fn close(&self) -> Result<()>;
   }

   pub type RecordStream = BoxStream<'static, Result<RecordBatch>>;
   ```

2. **定义 Sink trait**（`src/migration/sink/mod.rs`）
   ```rust
   #[async_trait]
   pub trait Sink: Send + Sync {
       /// 写入 Schema（DDL）
       async fn write_schema(&self, schema: &DatabaseSchema, strategy: TableStrategy) -> Result<()>;

       /// 创建数据写入器
       fn write(&self, table: &TableSchema) -> Result<Box<dyn RecordWriter>>;

       /// 预检查
       async fn preflight(&self, schema: &DatabaseSchema) -> Result<PreflightReport>;

       /// 事务控制
       async fn begin_transaction(&self) -> Result<Box<dyn Transaction>>;

       /// 关闭连接
       async fn close(&self) -> Result<()>;
   }

   #[async_trait]
   pub trait RecordWriter: Send + Sync {
       async fn write_batch(&mut self, batch: RecordBatch) -> Result<()>;
       async fn flush(&mut self) -> Result<()>;
   }
   ```

3. **复用现有连接池**
   - 复用 `src/datasource/pool.rs` 中的连接池管理
   - Source/Sink 实现通过 `connection_id` 获取连接

4. **MySQL Source 实现示例**
   ```rust
   pub struct MySqlSource {
       connection_id: i64,
       pool: ConnectionPool,
   }

   #[async_trait]
   impl Source for MySqlSource {
       async fn get_schema(&self, table_filter: Option<&[String]>) -> Result<DatabaseSchema> {
           // 复用现有元数据查询逻辑
       }

       fn read(&self, table: &TableSchema, options: ReadOptions) -> Result<RecordStream> {
           // 返回异步流
       }
   }
   ```

### 输出物
- `source/mod.rs` + `sink/mod.rs` 核心 trait
- MySQL/PostgreSQL/SQLite Source 实现
- MySQL/PostgreSQL/SQLite Sink 实现

---

## 任务 3: Schema 抽取与类型系统

### 目标
复用并扩展现有 Schema 元数据系统，支持迁移专用字段。

### 实现步骤

1. **复用现有模型**（参考 `er/models.rs` 和 `graph/query.rs`）
   ```rust
   // src/migration/models.rs
   use crate::er::models::TableInfo;
   use crate::graph::query::ColumnDetail;

   /// 数据库级 Schema
   #[derive(Debug, Clone, Serialize, Deserialize)]
   pub struct DatabaseSchema {
       pub name: String,
       pub tables: Vec<TableSchema>,
       pub views: Vec<ViewSchema>,
       pub relationships: Vec<Relationship>,
   }

   /// 表级 Schema（扩展自 TableInfo）
   #[derive(Debug, Clone, Serialize, Deserialize)]
   pub struct TableSchema {
       pub name: String,
       pub schema: Option<String>,
       pub columns: Vec<ColumnSchema>,
       pub primary_key: Option<Vec<String>>,
       pub indexes: Vec<IndexSchema>,
       pub constraints: Vec<ConstraintSchema>,
       pub estimated_rows: Option<u64>,
       pub engine: Option<String>, // MySQL 专用
       pub charset: Option<String>,
       pub collation: Option<String>,
       pub comment: Option<String>,
   }

   /// 列级 Schema（扩展自 ColumnDetail）
   #[derive(Debug, Clone, Serialize, Deserialize)]
   pub struct ColumnSchema {
       pub name: String,
       pub data_type: String,
       pub native_type: String, // 原始数据库类型
       pub nullable: bool,
       pub default_value: Option<String>,
       pub is_auto_increment: bool,
       pub comment: Option<String>,
       pub ordinal_position: i32,
       pub character_set: Option<String>,
       pub collation: Option<String>,
   }
   ```

2. **元数据查询实现**
   - 复用 `er/repository.rs` 中的查询方法
   - 扩展支持索引、约束、外键信息抽取

3. **类型映射系统**（`transform/type_map.rs`）
   ```rust
   /// 类型映射规则
   pub struct TypeMapping {
       pub from: DataType,
       pub to: DataType,
       pub converter: Option<Box<dyn TypeConverter>>,
   }

   /// 获取源到目标的类型映射
   pub fn map_type(
       source_type: &str,
       source_driver: &str,
       target_driver: &str,
   ) -> Result<String> {
       match (source_driver, target_driver) {
           ("mysql", "postgres") => mysql_to_postgres(source_type),
           ("postgres", "mysql") => postgres_to_mysql(source_type),
           // ... 其他组合
           _ => Ok(source_type.to_string()),
       }
   }

   /// MySQL → PostgreSQL 类型映射
   fn mysql_to_postgres(mysql_type: &str) -> Result<String> {
       let normalized = normalize_type(mysql_type);
       match normalized.as_str() {
           "tinyint" => Ok("smallint".to_string()),
           "int" => Ok("integer".to_string()),
           "bigint" => Ok("bigint".to_string()),
           "varchar(n)" => Ok(format!("varchar({})", extract_length(mysql_type).unwrap_or(255))),
           "text" => Ok("text".to_string()),
           "datetime" => Ok("timestamp".to_string()),
           "timestamp" => Ok("timestamp with time zone".to_string()),
           "json" => Ok("jsonb".to_string()),
           // ... 更多映射
           _ => Ok("text".to_string()), // fallback
       }
   }
   ```

### 输出物
- `models.rs` 完整数据结构
- `transform/type_map.rs` 类型映射系统
- 各 driver 的 Schema 抽取实现

---

## 任务 4: 数据迁移引擎（Pipeline）

### 目标
实现高性能并行数据迁移引擎，支持背压和进度报告。

### 实现步骤

1. **核心数据结构**（`engine/mod.rs`）
   ```rust
   /// 迁移任务配置
   #[derive(Debug, Clone, Serialize, Deserialize)]
   pub struct MigrationConfig {
       pub source_id: i64,
       pub target_id: i64,
       pub table_selection: TableSelection,
       pub strategy: MigrationStrategy,
       pub parallelism: usize,
       pub batch_size: usize,
       pub conflict_resolution: ConflictResolution,
   }

   #[derive(Debug, Clone, Serialize, Deserialize)]
   pub enum TableSelection {
       All,
       Include(Vec<String>),
       Exclude(Vec<String>),
   }

   #[derive(Debug, Clone, Serialize, Deserialize)]
   pub struct MigrationStrategy {
       pub table_strategy: TableStrategy,
       pub data_strategy: DataStrategy,
       pub index_strategy: IndexStrategy,
   }

   #[derive(Debug, Clone, Serialize, Deserialize)]
   pub enum TableStrategy {
       DropAndCreate,  // 先删除再重建
       CreateIfNotExists, // 不存在才创建
       Truncate,       // 清空后插入
       Append,         // 直接追加
   }

   #[derive(Debug, Clone, Serialize, Deserialize)]
   pub enum DataStrategy {
       Full,           // 全量迁移
       Incremental {   // 增量迁移
           key_column: String,
           last_value: Option<String>,
       },
   }

   /// 迁移状态
   #[derive(Debug, Clone, Serialize)]
   pub struct MigrationState {
       pub task_id: String,
       pub status: MigrationStatus,
       pub tables: Vec<TableMigrationState>,
       pub start_time: DateTime<Utc>,
       pub end_time: Option<DateTime<Utc>>,
       pub total_rows: u64,
       pub processed_rows: u64,
       pub error_count: u64,
   }
   ```

2. **Pipeline 引擎实现**（`engine/pipeline.rs`）
   ```rust
   pub struct MigrationPipeline {
       config: MigrationConfig,
       source: Arc<dyn Source>,
       sink: Arc<dyn Sink>,
       state: Arc<RwLock<MigrationState>>,
       progress_tx: Sender<ProgressEvent>,
       checkpoint_store: Arc<dyn CheckpointStore>,
   }

   impl MigrationPipeline {
       pub async fn run(mut self) -> Result<MigrationResult> {
           // 1. Schema 分析阶段
           self.emit_progress(Stage::SchemaAnalysis, 0.0).await;
           let schema = self.source.get_schema(self.get_table_filter()).await?;

           // 2. Schema 转换阶段
           self.emit_progress(Stage::SchemaTransform, 0.2).await;
           let transformed = self.transform_schema(&schema).await?;

           // 3. 目标库准备
           self.emit_progress(Stage::TargetPreparation, 0.3).await;
           self.sink.write_schema(&transformed, self.config.strategy.table_strategy).await?;

           // 4. 数据迁移阶段（并行执行）
           self.emit_progress(Stage::DataMigration, 0.4).await;
           let results = self.migrate_tables_parallel(&transformed.tables).await?;

           // 5. 索引创建阶段
           self.emit_progress(Stage::IndexCreation, 0.9).await;
           self.create_indexes(&transformed).await?;

           // 6. 完成
           self.emit_progress(Stage::Complete, 1.0).await;
           Ok(self.build_result(results))
       }

       async fn migrate_tables_parallel(
           &self,
           tables: &[TableSchema],
       ) -> Result<Vec<TableResult>> {
           let semaphore = Arc::new(Semaphore::new(self.config.parallelism));
           let mut handles = Vec::new();

           for table in tables {
               let permit = semaphore.clone().acquire_owned().await?;
               let handle = tokio::spawn(async move {
                   let result = self.migrate_table(table).await;
                   drop(permit);
                   result
               });
               handles.push(handle);
           }

           let results = futures::future::join_all(handles).await;
           results.into_iter().collect::<Result<Vec<_>, _>>()
       }

       async fn migrate_table(&self, table: &TableSchema) -> Result<TableResult> {
           // 检查断点
           let checkpoint = self.checkpoint_store.load(&self.config.task_id, &table.name).await?;
           let start_row = checkpoint.map(|c| c.last_row).unwrap_or(0);

           // 创建读写流
           let options = ReadOptions {
               offset: start_row,
               limit: None,
               batch_size: self.config.batch_size,
           };

           let mut stream = self.source.read(table, options)?;
           let mut writer = self.sink.write(table)?;

           let mut processed = 0u64;
           let mut last_checkpoint = start_row;

           while let Some(batch) = stream.next().await {
               let batch = batch?;
               writer.write_batch(batch).await?;
               processed += batch.len() as u64;

               // 每 10000 行保存断点
               if processed - last_checkpoint >= 10_000 {
                   self.checkpoint_store.save(
                       &self.config.task_id,
                       &table.name,
                       Checkpoint { last_row: processed },
                   ).await?;
                   last_checkpoint = processed;
               }

               // 发送进度
               self.emit_table_progress(&table.name, processed).await;
           }

           writer.flush().await?;
           Ok(TableResult { table: table.name.clone(), rows: processed })
       }
   }
   ```

3. **背压控制**
   ```rust
   /// 使用通道实现背压
   pub struct BackPressureStream {
       rx: Receiver<RecordBatch>,
       buffer_size: usize,
   }

   impl Stream for BackPressureStream {
       type Item = Result<RecordBatch>;

       fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
           self.rx.poll_recv(cx).map(|opt| opt.map(Ok))
       }
   }
   ```

4. **错误处理与重试**
   ```rust
   pub struct ErrorHandler {
       max_retries: u32,
       retryable_errors: Vec<ErrorKind>,
   }

   impl ErrorHandler {
       pub async fn execute_with_retry<F, Fut, T>(
           &self,
           operation: F,
       ) -> Result<T>
       where
           F: Fn() -> Fut,
           Fut: Future<Output = Result<T>>,
       {
           let mut attempts = 0;
           loop {
               match operation().await {
                   Ok(result) => return Ok(result),
                   Err(e) if self.is_retryable(&e) && attempts < self.max_retries => {
                       attempts += 1;
                       tokio::time::sleep(Duration::from_millis(100 * 2_u64.pow(attempts))).await;
                   }
                   Err(e) => return Err(e),
               }
           }
       }
   }
   ```

### 输出物
- `engine/pipeline.rs` Pipeline 主引擎
- `engine/task.rs` 任务管理
- `engine/checkpoint.rs` 断点管理
- 并行迁移实现

---

## 任务 5: DDL 转换与执行

### 目标
复用并扩展 ER 设计器的 DDL 生成能力，支持跨库 DDL 转换。

### 实现步骤

1. **复用现有 DDL 生成**（参考 `er/ddl_generator.rs`）
   ```rust
   // transform/ddl_gen.rs
   use crate::er::ddl_generator::DdlGenerator;

   pub struct CrossDbDdlGenerator {
       target_driver: String,
       type_mapper: TypeMapper,
   }

   impl CrossDbDdlGenerator {
       /// 生成目标库的 CREATE TABLE 语句
       pub fn generate_create_table(&self, table: &TableSchema) -> Result<String> {
           let mut sql = format!("CREATE TABLE IF NOT EXISTS {} (\n", table.name);

           let columns: Vec<String> = table.columns.iter()
               .map(|col| self.generate_column_def(col))
               .collect();

           sql.push_str(&columns.join(",\n"));

           // 主键
           if let Some(pk) = &table.primary_key {
               sql.push_str(&format!(",\n  PRIMARY KEY ({})\n)",
                   pk.join(", ")));
           } else {
               sql.push_str("\n)");
           }

           // 表级选项
           if let Some(charset) = &table.charset {
               sql.push_str(&format!(" CHARSET={}", charset));
           }

           Ok(sql)
       }

       fn generate_column_def(&self, column: &ColumnSchema) -> String {
           let mapped_type = self.type_mapper
               .map(&column.native_type, &self.target_driver);

           let mut def = format!("  {} {}", column.name, mapped_type);

           if !column.nullable {
               def.push_str(" NOT NULL");
           }

           if let Some(default) = &column.default_value {
               def.push_str(&format!(" DEFAULT {}", default));
           }

           if column.is_auto_increment {
               def.push_str(&self.auto_increment_clause());
           }

           if let Some(comment) = &column.comment {
               def.push_str(&format!(" COMMENT '{}'", comment));
           }

           def
       }

       fn auto_increment_clause(&self) -> &'static str {
           match self.target_driver.as_str() {
               "mysql" => " AUTO_INCREMENT",
               "postgres" => " SERIAL",
               "sqlite" => " AUTOINCREMENT",
               _ => "",
           }
       }
   }
   ```

2. **索引和约束生成**
   ```rust
   impl CrossDbDdlGenerator {
       pub fn generate_indexes(&self, table: &TableSchema) -> Vec<String> {
           table.indexes.iter()
               .map(|idx| {
                   let unique = if idx.is_unique { "UNIQUE " } else { "" };
                   format!(
                       "CREATE {}INDEX {} ON {} ({})",
                       unique,
                       idx.name,
                       table.name,
                       idx.columns.join(", ")
                   )
               })
               .collect()
       }

       pub fn generate_foreign_keys(&self, table: &TableSchema) -> Vec<String> {
           table.constraints.iter()
               .filter(|c| c.constraint_type == "FOREIGN_KEY")
               .map(|fk| {
                   format!(
                       "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}({})",
                       table.name,
                       fk.name,
                       fk.local_columns.join(", "),
                       fk.ref_table.as_ref().unwrap(),
                       fk.ref_columns.as_ref().unwrap().join(", ")
                   )
               })
               .collect()
       }
   }
   ```

3. **冲突解决策略**
   ```rust
   #[derive(Debug, Clone)]
   pub enum ConflictResolution {
       Skip,           // 跳过已存在
       Replace,        // 替换
       Upsert,         // 插入或更新
       Error,          // 报错
   }

   pub fn generate_upsert_sql(
       table: &TableSchema,
       driver: &str,
   ) -> Result<String> {
       match driver {
           "mysql" => Ok(format!(
               "INSERT INTO {} (...) VALUES (...) ON DUPLICATE KEY UPDATE ...",
               table.name
           )),
           "postgres" => Ok(format!(
               "INSERT INTO {} (...) VALUES (...) ON CONFLICT (...) DO UPDATE SET ...",
               table.name
           )),
           "sqlite" => Ok(format!(
               "INSERT OR REPLACE INTO {} (...) VALUES ...",
               table.name
           )),
           _ => Err(Error::UnsupportedDriver(driver.to_string())),
       }
   }
   ```

### 输出物
- `transform/ddl_gen.rs` DDL 生成器
- `transform/schema.rs` Schema 转换
- 各 driver 的 DDL 方言实现

---

## 任务 6: 前端 Task 进度组件复用

### 目标
复用 ImportExport 模块的 TaskProgress 组件，适配迁移场景。

### 实现步骤

1. **检查现有组件**（复用 `ImportExport/TaskManager/index.tsx`）
   - 确认组件支持 `task-progress` 事件格式
   - 复用 `useTaskProgress` hook

2. **适配迁移专用字段**
   ```typescript
   // src/components/Migration/TaskProgress.tsx（复用并扩展）
   import { TaskProgress as BaseTaskProgress } from '../ImportExport/TaskManager';

   export interface MigrationProgressEvent {
     taskId: string;
     status: 'running' | 'completed' | 'failed' | 'paused';
     stage: 'schema_analysis' | 'schema_transform' | 'data_migration' | 'index_creation' | 'complete';
     progress: number; // 0-100
     currentTable?: string;
     processedRows: number;
     totalRows?: number;
     tablesCompleted: number;
     totalTables: number;
     errors: MigrationError[];
     logLines: LogLine[];
   }

   export const MigrationTaskProgress: React.FC<{
     taskId: string;
     onComplete?: () => void;
     onError?: (error: Error) => void;
   }> = ({ taskId, onComplete, onError }) => {
     // 复用基础逻辑，扩展迁移专用 UI
   };
   ```

3. **迁移专用进度展示**
   ```typescript
   const MigrationStageIndicator: React.FC<{ stage: MigrationStage }> = ({ stage }) => {
     const stages = [
       { key: 'schema_analysis', label: 'Schema 分析', icon: SearchIcon },
       { key: 'schema_transform', label: '类型转换', icon: TransformIcon },
       { key: 'data_migration', label: '数据迁移', icon: DatabaseIcon },
       { key: 'index_creation', label: '索引创建', icon: IndexIcon },
       { key: 'complete', label: '完成', icon: CheckIcon },
     ];

     return (
       <Steps current={stages.findIndex(s => s.key === stage)}>
         {stages.map(s => <Step key={s.key} {...s} />)}
       </Steps>
     );
   };
   ```

### 输出物
- 复用的 TaskProgress 组件
- 迁移专用进度指示器
- 适配迁移事件的 hooks

---

## 任务 7: 迁移中心前端页面

### 目标
实现迁移向导 UI（4 步：选择源目标 → 表映射 → 策略配置 → 执行监控）。

### 实现步骤

1. **页面路由与布局**
   ```typescript
   // src/pages/MigrationCenter/index.tsx
   export const MigrationCenterPage: React.FC = () => {
     const [currentStep, setCurrentStep] = useState(0);
     const [config, setConfig] = useState<Partial<MigrationConfig>>({});

     const steps = [
       { title: '选择数据源', component: SourceTargetStep },
       { title: '表映射', component: TableMappingStep },
       { title: '策略配置', component: StrategyConfigStep },
       { title: '执行监控', component: ExecutionMonitorStep },
     ];

     return (
       <PageContainer title="迁移中心">
         <Steps current={currentStep}>
           {steps.map(s => <Step key={s.title} title={s.title} />)}
         </Steps>
         <Card className="mt-4">
           <CurrentStepComponent
             config={config}
             onConfigChange={setConfig}
             onNext={() => setCurrentStep(s => s + 1)}
             onPrev={() => setCurrentStep(s => s - 1)}
           />
         </Card>
       </PageContainer>
     );
   };
   ```

2. **Step 1: 源/目标选择**
   ```typescript
   const SourceTargetStep: React.FC<StepProps> = ({ config, onConfigChange, onNext }) => {
     const connections = useConnections(); // 复用现有连接列表

     return (
       <Form layout="vertical">
         <Form.Item label="源数据库">
           <ConnectionSelector
             value={config.sourceId}
             onChange={id => onConfigChange({ ...config, sourceId: id })}
             connections={connections}
           />
         </Form.Item>
         <Form.Item label="目标数据库">
           <ConnectionSelector
             value={config.targetId}
             onChange={id => onConfigChange({ ...config, targetId: id })}
             connections={connections}
             exclude={config.sourceId}
           />
         </Form.Item>
         <Form.Item>
           <Button type="primary" onClick={onNext}>下一步</Button>
         </Form.Item>
       </Form>
     );
   };
   ```

3. **Step 2: 表映射**
   ```typescript
   const TableMappingStep: React.FC<StepProps> = ({ config, onConfigChange, onNext }) => {
     const { tables, loading } = useSourceTables(config.sourceId!);
     const [selectedTables, setSelectedTables] = useState<string[]>([]);
     const [mappings, setMappings] = useState<TableMapping[]>([]);

     return (
       <div>
         <Table
           rowSelection={{
             selectedRowKeys: selectedTables,
             onChange: setSelectedTables,
           }}
           columns={[
             { title: '表名', dataIndex: 'name' },
             { title: '行数', dataIndex: 'rowCount' },
             { title: '大小', dataIndex: 'size' },
             {
               title: '目标表名',
               render: (_, record) => (
                 <Input
                   value={mappings.find(m => m.source === record.name)?.target}
                   onChange={e => updateMapping(record.name, e.target.value)}
                 />
               ),
             },
           ]}
           dataSource={tables}
           loading={loading}
         />
         {/* 预览转换后的 DDL */}
         <SchemaPreview sourceId={config.sourceId} targetId={config.targetId} tables={selectedTables} />
       </div>
     );
   };
   ```

4. **Step 3: 策略配置**
   ```typescript
   const StrategyConfigStep: React.FC<StepProps> = ({ config, onConfigChange, onNext }) => {
     return (
       <Form layout="vertical">
         <Form.Item label="表策略">
           <Select
             value={config.tableStrategy}
             onChange={v => onConfigChange({ ...config, tableStrategy: v })}
           >
             <Select.Option value="drop_and_create">删除并重建</Select.Option>
             <Select.Option value="create_if_not_exists">仅当不存在时创建</Select.Option>
             <Select.Option value="truncate">清空后插入</Select.Option>
             <Select.Option value="append">直接追加</Select.Option>
           </Select>
         </Form.Item>
         <Form.Item label="数据策略">
           <Radio.Group
             value={config.dataStrategy}
             onChange={e => onConfigChange({ ...config, dataStrategy: e.target.value })}
           >
             <Radio value="full">全量迁移</Radio>
             <Radio value="incremental">增量迁移</Radio>
           </Radio.Group>
         </Form.Item>
         <Form.Item label="并发度">
           <Slider
             min={1}
             max={10}
             value={config.parallelism}
             onChange={v => onConfigChange({ ...config, parallelism: v })}
           />
         </Form.Item>
         <Form.Item label="批处理大小">
           <InputNumber
             value={config.batchSize}
             onChange={v => onConfigChange({ ...config, batchSize: v })}
             min={100}
             max={10000}
           />
         </Form.Item>
         <Form.Item label="冲突解决">
           <Select
             value={config.conflictResolution}
             onChange={v => onConfigChange({ ...config, conflictResolution: v })}
           >
             <Select.Option value="skip">跳过</Select.Option>
             <Select.Option value="replace">替换</Select.Option>
             <Select.Option value="upsert">插入或更新</Select.Option>
             <Select.Option value="error">报错</Select.Option>
           </Select>
         </Form.Item>
       </Form>
     );
   };
   ```

5. **Step 4: 执行监控**
   ```typescript
   const ExecutionMonitorStep: React.FC<StepProps> = ({ config }) => {
     const [taskId, setTaskId] = useState<string | null>(null);

     const startMigration = async () => {
       const id = await invoke<string>('migration_start', { config });
       setTaskId(id);
     };

     if (!taskId) {
       return (
         <Alert
           message="准备开始迁移"
           description="点击开始按钮启动迁移任务"
           action={<Button type="primary" onClick={startMigration}>开始迁移</Button>}
         />
       );
     }

     return <MigrationTaskProgress taskId={taskId} />;
   };
   ```

### 输出物
- `src/pages/MigrationCenter/index.tsx` 主页面
- 4 个 Step 组件
- 复用的连接选择器、表选择器组件

---

## 任务 8: Tauri 命令层开发

### 目标
实现前端调用的 Tauri 命令集合。

### 实现步骤

1. **命令定义**（`src/migration/commands.rs`）
   ```rust
   use tauri::State;
   use crate::migration::engine::MigrationPipeline;
   use crate::migration::models::*;

   /// 分析源数据库 Schema
   #[tauri::command]
   pub async fn migration_analyze_source(
       source_id: i64,
       table_filter: Option<Vec<String>>,
       state: State<'_, AppState>,
   ) -> Result<DatabaseSchema, String> {
       let source = create_source(source_id, &state).await?;
       source.get_schema(table_filter.as_deref())
           .await
           .map_err(|e| e.to_string())
   }

   /// 预览 DDL 转换结果
   #[tauri::command]
   pub async fn migration_preview_ddl(
       source_id: i64,
       target_id: i64,
       tables: Vec<String>,
       state: State<'_, AppState>,
   ) -> Result<DdlPreview, String> {
       let source = create_source(source_id, &state).await?;
       let schema = source.get_schema(Some(&tables)).await?;

       let type_mapper = TypeMapper::for_target(target_id, &state).await?;
       let ddl_gen = CrossDbDdlGenerator::new(type_mapper);

       let preview: Vec<TableDdl> = schema.tables.iter()
           .map(|t| TableDdl {
               table_name: t.name.clone(),
               create_sql: ddl_gen.generate_create_table(t).ok(),
               indexes: ddl_gen.generate_indexes(t),
           })
           .collect();

       Ok(DdlPreview { tables: preview })
   }

   /// 启动迁移任务
   #[tauri::command]
   pub async fn migration_start(
       config: MigrationConfig,
       app_handle: tauri::AppHandle,
       state: State<'_, AppState>,
   ) -> Result<String, String> {
       let task_id = generate_task_id();

       // 创建管道
       let source = create_source(config.source_id, &state).await?;
       let sink = create_sink(config.target_id, &state).await?;

       let pipeline = MigrationPipeline::new(
           task_id.clone(),
           config,
           source,
           sink,
           app_handle.clone(),
       );

       // 注册任务并启动
       state.migration_tasks.insert(task_id.clone(), pipeline);

       tokio::spawn(async move {
           if let Err(e) = pipeline.run().await {
               log::error!("Migration failed: {}", e);
           }
       });

       Ok(task_id)
   }

   /// 获取迁移状态
   #[tauri::command]
   pub async fn migration_get_status(
       task_id: String,
       state: State<'_, AppState>,
   ) -> Result<MigrationState, String> {
       state.migration_tasks
           .get(&task_id)
           .map(|t| t.state().clone())
           .ok_or_else(|| "Task not found".to_string())
   }

   /// 暂停迁移
   #[tauri::command]
   pub async fn migration_pause(
       task_id: String,
       state: State<'_, AppState>,
   ) -> Result<(), String> {
       state.migration_tasks
           .get(&task_id)
           .map(|t| t.pause())
           .ok_or_else(|| "Task not found".to_string())
   }

   /// 恢复迁移
   #[tauri::command]
   pub async fn migration_resume(
       task_id: String,
       state: State<'_, AppState>,
   ) -> Result<(), String> {
       state.migration_tasks
           .get(&task_id)
           .map(|t| t.resume())
           .ok_or_else(|| "Task not found".to_string())
   }

   /// 取消迁移
   #[tauri::command]
   pub async fn migration_cancel(
       task_id: String,
       state: State<'_, AppState>,
   ) -> Result<(), String> {
       state.migration_tasks
           .get(&task_id)
           .map(|t| t.cancel())
           .ok_or_else(|| "Task not found".to_string())
   }

   /// 获取迁移历史
   #[tauri::command]
   pub async fn migration_list_history(
       limit: Option<usize>,
       state: State<'_, AppState>,
   ) -> Result<Vec<MigrationHistory>, String> {
       let db = state.db.lock().await;
       db.query(
           "SELECT * FROM migration_tasks ORDER BY created_at DESC LIMIT ?",
           params![limit.unwrap_or(50)],
       )
       .map_err(|e| e.to_string())
   }
   ```

2. **注册命令**
   ```rust
   // src/lib.rs
   generate_handler![
       // ... 现有命令
       migration_analyze_source,
       migration_preview_ddl,
       migration_start,
       migration_get_status,
       migration_pause,
       migration_resume,
       migration_cancel,
       migration_list_history,
   ]
   ```

3. **事件发射**（复用现有格式）
   ```rust
   impl MigrationPipeline {
       async fn emit_progress(&self, stage: Stage, progress: f32) {
           let event = TaskProgressEvent {
               task_id: self.task_id.clone(),
               status: "running".to_string(),
               progress,
               processed_rows: self.processed_rows(),
               total_rows: self.total_rows(),
               current_target: format!("{:?}", stage),
               // ... 其他字段
           };
           self.app_handle.emit("task-progress", event).ok();
       }
   }
   ```

### 输出物
- `commands.rs` 完整命令实现
- `lib.rs` 命令注册
- 事件发射集成

---

## 任务 9: 断点续传与恢复机制

### 目标
实现可靠的断点续传，支持任务中断后的恢复。

### 实现步骤

1. **Checkpoint 存储**（`engine/checkpoint.rs`）
   ```rust
   #[derive(Debug, Clone, Serialize, Deserialize)]
   pub struct Checkpoint {
       pub task_id: String,
       pub table_name: String,
       pub last_row: u64,
       pub last_primary_key: Option<String>, // 用于增量断点
       pub updated_at: DateTime<Utc>,
   }

   #[async_trait]
   pub trait CheckpointStore: Send + Sync {
       async fn save(&self, checkpoint: &Checkpoint) -> Result<()>;
       async fn load(&self, task_id: &str, table_name: &str) -> Result<Option<Checkpoint>>;
       async fn delete(&self, task_id: &str) -> Result<()>;
       async fn list(&self, task_id: &str) -> Result<Vec<Checkpoint>>;
   }

   /// SQLite 实现
   pub struct SqliteCheckpointStore {
       db: Arc<Mutex<Connection>>,
   }

   #[async_trait]
   impl CheckpointStore for SqliteCheckpointStore {
       async fn save(&self, checkpoint: &Checkpoint) -> Result<()> {
           let db = self.db.lock().await;
           db.execute(
               "INSERT INTO migration_checkpoints (task_id, table_name, last_row, last_primary_key, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(task_id, table_name) DO UPDATE SET
                  last_row = excluded.last_row,
                  last_primary_key = excluded.last_primary_key,
                  updated_at = excluded.updated_at",
               params![
                   checkpoint.task_id,
                   checkpoint.table_name,
                   checkpoint.last_row,
                   checkpoint.last_primary_key,
                   checkpoint.updated_at
               ],
           )?;
           Ok(())
       }

       // ... 其他方法实现
   }
   ```

2. **断点恢复逻辑**
   ```rust
   impl MigrationPipeline {
       async fn resume_from_checkpoint(&self) -> Result<()> {
           let checkpoints = self.checkpoint_store.list(&self.task_id).await?;

           for cp in checkpoints {
               // 检查该表是否已完成
               if self.is_table_complete(&cp.table_name).await? {
                   continue;
               }

               // 从断点恢复
               let table = self.get_table_schema(&cp.table_name).await?;
               self.migrate_table_from_checkpoint(&table, cp).await?;
           }

           Ok(())
       }

       async fn migrate_table_from_checkpoint(
           &self,
           table: &TableSchema,
           checkpoint: Checkpoint,
       ) -> Result<()> {
           let options = ReadOptions {
               offset: checkpoint.last_row,
               limit: None,
               batch_size: self.config.batch_size,
           };

           // 继续从断点读取
           let mut stream = self.source.read(table, options)?;
           // ... 继续迁移
       }
   }
   ```

3. **任务状态持久化**
   ```sql
   -- Schema 扩展
   CREATE TABLE migration_tasks (
       id TEXT PRIMARY KEY,
       source_id INTEGER NOT NULL,
       target_id INTEGER NOT NULL,
       config JSON NOT NULL,
       status TEXT NOT NULL, -- pending, running, paused, completed, failed
       progress REAL DEFAULT 0,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       completed_at TIMESTAMP,
       error_message TEXT
   );

   CREATE TABLE migration_checkpoints (
       task_id TEXT NOT NULL,
       table_name TEXT NOT NULL,
       last_row INTEGER NOT NULL,
       last_primary_key TEXT,
       updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (task_id, table_name),
       FOREIGN KEY (task_id) REFERENCES migration_tasks(id) ON DELETE CASCADE
   );
   ```

### 输出物
- `engine/checkpoint.rs` 断点管理
- 状态持久化表结构
- 恢复逻辑实现

---

## 任务 10: 集成测试与性能调优

### 目标
确保迁移正确性和性能，达到设计指标。

### 实现步骤

1. **测试策略**
   - 单元测试：类型映射、DDL 生成、Record 转换
   - 集成测试：端到端迁移（MySQL→PostgreSQL 等）
   - 性能测试：大数据量（100万+行）迁移

2. **测试用例示例**
   ```rust
   #[tokio::test]
   async fn test_mysql_to_postgres_migration() {
       // 1. 创建源数据库和测试数据
       let source = TestDb::mysql().await;
       source.execute("CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(255))").await;
       source.insert_test_data("users", 10000).await;

       // 2. 创建目标数据库
       let target = TestDb::postgres().await;

       // 3. 执行迁移
       let pipeline = MigrationPipeline::new(
           "test-task".to_string(),
           MigrationConfig {
               source_id: source.id(),
               target_id: target.id(),
               table_selection: TableSelection::All,
               strategy: default_strategy(),
               parallelism: 4,
               batch_size: 1000,
               conflict_resolution: ConflictResolution::Error,
           },
           // ...
       );

       let result = pipeline.run().await.unwrap();

       // 4. 验证结果
       assert_eq!(result.total_rows, 10000);
       assert!(target.table_exists("users").await);
       assert_eq!(target.count_rows("users").await, 10000);

       // 5. 验证数据一致性
       let source_data = source.query("SELECT * FROM users ORDER BY id").await;
       let target_data = target.query("SELECT * FROM users ORDER BY id").await;
       assert_eq!(source_data, target_data);
   }
   ```

3. **性能基准测试**
   ```rust
   #[tokio::test]
   async fn benchmark_large_migration() {
       let source = TestDb::mysql().await;
       source.insert_test_data("large_table", 1_000_000).await;

       let start = Instant::now();
       // ... 执行迁移
       let duration = start.elapsed();

       let rows_per_second = 1_000_000.0 / duration.as_secs_f64();
       println!("Throughput: {:.2} rows/sec", rows_per_second);

       // 断言吞吐量 > 5000 rows/sec
       assert!(rows_per_second > 5000.0);
   }
   ```

4. **性能调优清单**
   - [ ] 批量插入优化（Prepared Statement）
   - [ ] 连接池参数调优
   - [ ] 并行度调优（默认 CPU 核心数）
   - [ ] 批处理大小调优（默认 1000）
   - [ ] 内存使用优化（流式处理）

### 输出物
- 单元测试覆盖
- 集成测试套件
- 性能基准测试
- 调优指南

---

## 任务 11: 文档与示例

### 目标
完成用户文档和开发文档。

### 实现步骤

1. **用户文档**
   - `docs/modules/migration-center.md`（复用模块文档模板）
   - 操作指南：如何选择源目标、表映射配置、策略选择
   - 故障排查：常见错误和解决方法

2. **开发文档**
   - `docs/superpowers/specs/migration-center-design.md`（已存在）
   - `src/migration/README.md`：模块架构说明
   - API 文档：Source/Sink trait 说明

3. **代码示例**
   ```rust
   // 示例：自定义数据转换
   use open_db_studio::migration::transform::Transform;

   struct CustomTransform;

   impl Transform for CustomTransform {
       fn transform_record(&self, record: &mut Record) -> Result<()> {
           // 自定义转换逻辑
           if let Some(value) = record.get("phone") {
               record.set("phone", mask_phone(value)?);
           }
           Ok(())
       }
   }

   let pipeline = MigrationPipeline::new(config, source, sink)
       .with_transform(CustomTransform);
   ```

4. **更新相关文档**
   - `docs/PLANS.md`: 标记迁移中心为已完成
   - `docs/QUALITY_SCORE.md`: 更新覆盖率统计

### 输出物
- 用户操作指南
- 开发者文档
- 代码示例
- 更新后的路线图

---

## 风险与应对

| 风险 | 影响 | 应对策略 |
|------|------|----------|
| 类型映射不完整 | 某些数据类型迁移失败 | 建立 fallback 机制，未知类型映射为 TEXT |
| 大数据量内存溢出 | 应用崩溃 | 严格流式处理 + 背压控制 |
| 目标库写入慢 | 迁移时间过长 | 批量写入 + 并行优化 + 可调参数 |
| 网络中断 | 迁移失败 | 断点续传 + 自动重试机制 |
| 跨库特性不支持 | DDL 转换失败 | 预检查报告 + 手动调整建议 |

---

## 附录：与现有代码的复用点

| 组件 | 现有代码 | 复用方式 |
|------|----------|----------|
| Schema 模型 | `er/models.rs` | 扩展复用 |
| 元数据查询 | `er/repository.rs` | 调用现有方法 |
| DDL 生成 | `er/ddl_generator.rs` | 扩展复用 |
| 连接池 | `datasource/pool.rs` | 复用连接池 |
| 进度组件 | `ImportExport/TaskManager` | 复用并扩展 |
| Task 事件 | `task-progress` | 复用事件格式 |
| 类型系统 | `er/models.rs` 字段定义 | 扩展类型映射 |
