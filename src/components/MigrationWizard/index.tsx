import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Trash2, Plus, CheckCircle, XCircle, AlertTriangle, Info, Loader2, History, X } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Connection {
  id: number;
  name: string;
  driver: string;
}

interface MigrationTableConfig {
  src_table: string;
  dst_table: string;
}

interface MigrationConfig {
  tables: MigrationTableConfig[];
  batch_size: number;
  skip_errors: boolean;
}

interface MigrationProgress {
  task_id: number;
  current_table: string;
  done_rows: number;
  total_rows: number;
  error_count: number;
}

interface MigrationTask {
  id: number;
  name: string;
  src_connection_id: number;
  dst_connection_id: number;
  config: MigrationConfig;
  status: 'pending' | 'running' | 'paused' | 'done' | 'failed';
  progress?: MigrationProgress;
  created_at: string;
}

interface CheckItem {
  name: string;
  severity: string;
  message: string;
  passed: boolean;
}

interface PreCheckResult {
  task_id: number;
  checks: CheckItem[];
  has_errors: boolean;
  has_warnings: boolean;
}

// ─── Step Indicator ───────────────────────────────────────────────────────────

const STEP_LABELS = ['选择连接', '配置表映射', '预检报告', '迁移进度'];

function StepIndicator({ step }: { step: 1 | 2 | 3 | 4 }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-8">
      {STEP_LABELS.map((label, i) => {
        const stepNum = i + 1;
        const isActive = stepNum === step;
        const isDone = stepNum < step;
        return (
          <React.Fragment key={stepNum}>
            <div className="flex flex-col items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold border-2 transition-all ${
                  isActive
                    ? 'bg-[#00c9a7] border-[#00c9a7] text-[#0d1117]'
                    : isDone
                    ? 'bg-[#00c9a7] border-[#00c9a7] text-[#0d1117]'
                    : 'bg-[#1e2d42] border-[#253347] text-[#7a9bb8]'
                }`}
              >
                {isDone ? <CheckCircle size={16} /> : stepNum}
              </div>
              <span
                className={`mt-1.5 text-xs whitespace-nowrap ${
                  isActive ? 'text-[#00c9a7]' : isDone ? 'text-[#00c9a7]' : 'text-[#7a9bb8]'
                }`}
              >
                {label}
              </span>
            </div>
            {i < STEP_LABELS.length - 1 && (
              <div
                className={`h-0.5 w-16 mt-[-14px] mx-1 transition-all ${
                  stepNum < step ? 'bg-[#00c9a7]' : 'bg-[#253347]'
                }`}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─── Step 1: Select Connections ───────────────────────────────────────────────

interface Step1Props {
  name: string;
  setName: (v: string) => void;
  srcId: number | null;
  setSrcId: (v: number | null) => void;
  dstId: number | null;
  setDstId: (v: number | null) => void;
  batchSize: number;
  setBatchSize: (v: number) => void;
  skipErrors: boolean;
  setSkipErrors: (v: boolean) => void;
  onNext: () => void;
  connections: Connection[];
  loadingConnections: boolean;
}

function Step1({
  name, setName, srcId, setSrcId, dstId, setDstId,
  batchSize, setBatchSize, skipErrors, setSkipErrors,
  onNext, connections, loadingConnections,
}: Step1Props) {
  const canProceed = name.trim() !== '' && srcId !== null && dstId !== null && srcId !== dstId;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <label className="block text-[#7a9bb8] text-xs mb-1.5">任务名称 <span className="text-red-400">*</span></label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="输入迁移任务名称"
          className="w-full bg-[#1a2639] border border-[#253347] rounded px-3 py-2 text-[#c8daea] text-sm placeholder-[#4a6a8a] focus:outline-none focus:border-[#00c9a7] transition-colors"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[#7a9bb8] text-xs mb-1.5">源连接 <span className="text-red-400">*</span></label>
          <select
            value={srcId ?? ''}
            onChange={(e) => setSrcId(e.target.value ? Number(e.target.value) : null)}
            className="w-full bg-[#1a2639] border border-[#253347] rounded px-3 py-2 text-[#c8daea] text-sm focus:outline-none focus:border-[#00c9a7] transition-colors"
            disabled={loadingConnections}
          >
            <option value="">-- 选择源连接 --</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.driver})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[#7a9bb8] text-xs mb-1.5">目标连接 <span className="text-red-400">*</span></label>
          <select
            value={dstId ?? ''}
            onChange={(e) => setDstId(e.target.value ? Number(e.target.value) : null)}
            className="w-full bg-[#1a2639] border border-[#253347] rounded px-3 py-2 text-[#c8daea] text-sm focus:outline-none focus:border-[#00c9a7] transition-colors"
            disabled={loadingConnections}
          >
            <option value="">-- 选择目标连接 --</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.driver})
              </option>
            ))}
          </select>
        </div>
      </div>

      {srcId !== null && dstId !== null && srcId === dstId && (
        <p className="text-red-400 text-xs">源连接和目标连接不能相同</p>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[#7a9bb8] text-xs mb-1.5">批量大小</label>
          <input
            type="number"
            value={batchSize}
            onChange={(e) => setBatchSize(Math.max(1, Number(e.target.value)))}
            min={1}
            className="w-full bg-[#1a2639] border border-[#253347] rounded px-3 py-2 text-[#c8daea] text-sm focus:outline-none focus:border-[#00c9a7] transition-colors"
          />
        </div>
        <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={skipErrors}
              onChange={(e) => setSkipErrors(e.target.checked)}
              className="w-4 h-4 rounded accent-[#00c9a7]"
            />
            <span className="text-[#c8daea] text-sm">跳过错误行</span>
          </label>
        </div>
      </div>

      <div className="flex justify-end pt-2">
        <button
          onClick={onNext}
          disabled={!canProceed}
          className="bg-[#00c9a7] hover:bg-[#00b093] disabled:bg-[#1e2d42] disabled:text-[#4a6a8a] disabled:cursor-not-allowed text-[#0d1117] rounded px-5 py-2 text-sm font-semibold transition-colors"
        >
          下一步
        </button>
      </div>
    </div>
  );
}

// ─── Step 2: Table Mapping ────────────────────────────────────────────────────

interface TableRow {
  src_table: string;
  dst_table: string;
}

interface Step2Props {
  tables: TableRow[];
  setTables: (v: TableRow[]) => void;
  onPrev: () => void;
  onNext: () => void;
  loading: boolean;
}

function Step2({ tables, setTables, onPrev, onNext, loading }: Step2Props) {
  const canProceed = tables.length > 0 && tables.every((t) => t.src_table.trim() && t.dst_table.trim());

  const addRow = () => setTables([...tables, { src_table: '', dst_table: '' }]);

  const removeRow = (idx: number) => setTables(tables.filter((_, i) => i !== idx));

  const updateRow = (idx: number, field: 'src_table' | 'dst_table', value: string) => {
    setTables(tables.map((row, i) => (i === idx ? { ...row, [field]: value } : row)));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[#c8daea] text-sm font-semibold">表映射配置</h3>
        <button
          onClick={addRow}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#1a2639] hover:bg-[#253347] rounded border border-[#253347] text-[#c8daea] transition-colors"
        >
          <Plus size={14} /> 添加表
        </button>
      </div>

      <div className="border border-[#1e2d42] rounded overflow-hidden">
        <div className="grid grid-cols-[1fr_1fr_auto] bg-[#0d1117] border-b border-[#1e2d42]">
          <div className="px-3 py-2 text-xs text-[#7a9bb8] font-medium">源表</div>
          <div className="px-3 py-2 text-xs text-[#7a9bb8] font-medium">目标表</div>
          <div className="px-3 py-2 text-xs text-[#7a9bb8] font-medium w-12"></div>
        </div>
        {tables.length === 0 ? (
          <div className="px-3 py-6 text-center text-[#4a6a8a] text-sm">
            点击"添加表"配置迁移表映射
          </div>
        ) : (
          tables.map((row, idx) => (
            <div
              key={idx}
              className="grid grid-cols-[1fr_1fr_auto] border-b border-[#1e2d42] last:border-b-0"
            >
              <div className="px-2 py-1.5">
                <input
                  type="text"
                  value={row.src_table}
                  onChange={(e) => updateRow(idx, 'src_table', e.target.value)}
                  placeholder="源表名"
                  className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1 text-[#c8daea] text-xs placeholder-[#4a6a8a] focus:outline-none focus:border-[#00c9a7] transition-colors"
                />
              </div>
              <div className="px-2 py-1.5">
                <input
                  type="text"
                  value={row.dst_table}
                  onChange={(e) => updateRow(idx, 'dst_table', e.target.value)}
                  placeholder="目标表名"
                  className="w-full bg-[#1a2639] border border-[#253347] rounded px-2 py-1 text-[#c8daea] text-xs placeholder-[#4a6a8a] focus:outline-none focus:border-[#00c9a7] transition-colors"
                />
              </div>
              <div className="px-2 py-1.5 flex items-center justify-center w-12">
                <button
                  onClick={() => removeRow(idx)}
                  className="text-[#7a9bb8] hover:text-red-400 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {tables.length > 0 && !canProceed && (
        <p className="text-red-400 text-xs">请填写所有行的源表和目标表名称</p>
      )}

      <div className="flex justify-between pt-2">
        <button
          onClick={onPrev}
          disabled={loading}
          className="px-4 py-2 text-sm bg-[#1a2639] hover:bg-[#253347] rounded border border-[#253347] text-[#c8daea] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          上一步
        </button>
        <button
          onClick={onNext}
          disabled={!canProceed || loading}
          className="flex items-center gap-2 bg-[#00c9a7] hover:bg-[#00b093] disabled:bg-[#1e2d42] disabled:text-[#4a6a8a] disabled:cursor-not-allowed text-[#0d1117] rounded px-5 py-2 text-sm font-semibold transition-colors"
        >
          {loading && <Loader2 size={14} className="animate-spin" />}
          {loading ? '处理中...' : '下一步（创建任务）'}
        </button>
      </div>
    </div>
  );
}

// ─── Step 3: Pre-check Report ─────────────────────────────────────────────────

function severityBadge(severity: string) {
  switch (severity) {
    case 'error':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-red-900/40 text-red-400 border border-red-800/50">
          <XCircle size={10} /> 错误
        </span>
      );
    case 'warning':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-yellow-900/40 text-yellow-400 border border-yellow-800/50">
          <AlertTriangle size={10} /> 警告
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-blue-900/40 text-blue-400 border border-blue-800/50">
          <Info size={10} /> 信息
        </span>
      );
  }
}

interface Step3Props {
  preCheck: PreCheckResult;
  onPrev: () => void;
  onStart: () => void;
}

function Step3({ preCheck, onPrev, onStart }: Step3Props) {
  const errorCount = preCheck.checks.filter((c) => c.severity === 'error').length;
  const warnCount = preCheck.checks.filter((c) => c.severity === 'warning').length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4 p-3 rounded bg-[#0d1117] border border-[#1e2d42]">
        <div className="flex items-center gap-2">
          <span className="text-[#7a9bb8] text-xs">错误:</span>
          <span className={`text-sm font-bold ${errorCount > 0 ? 'text-red-400' : 'text-[#00c9a7]'}`}>
            {errorCount}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[#7a9bb8] text-xs">警告:</span>
          <span className={`text-sm font-bold ${warnCount > 0 ? 'text-yellow-400' : 'text-[#00c9a7]'}`}>
            {warnCount}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[#7a9bb8] text-xs">检查项:</span>
          <span className="text-sm font-bold text-[#c8daea]">{preCheck.checks.length}</span>
        </div>
      </div>

      <div className="border border-[#1e2d42] rounded overflow-hidden max-h-72 overflow-y-auto">
        <div className="grid grid-cols-[auto_1fr_2fr_auto] bg-[#0d1117] border-b border-[#1e2d42] sticky top-0">
          <div className="px-3 py-2 text-xs text-[#7a9bb8] font-medium">级别</div>
          <div className="px-3 py-2 text-xs text-[#7a9bb8] font-medium">检查项</div>
          <div className="px-3 py-2 text-xs text-[#7a9bb8] font-medium">信息</div>
          <div className="px-3 py-2 text-xs text-[#7a9bb8] font-medium">结果</div>
        </div>
        {preCheck.checks.map((item, idx) => (
          <div
            key={idx}
            className="grid grid-cols-[auto_1fr_2fr_auto] border-b border-[#1e2d42] last:border-b-0 hover:bg-[#1a2639]/30"
          >
            <div className="px-3 py-2.5">{severityBadge(item.severity)}</div>
            <div className="px-3 py-2.5 text-[#c8daea] text-xs">{item.name}</div>
            <div className="px-3 py-2.5 text-[#7a9bb8] text-xs">{item.message}</div>
            <div className="px-3 py-2.5 flex items-center">
              {item.passed ? (
                <CheckCircle size={14} className="text-[#00c9a7]" />
              ) : (
                <XCircle size={14} className="text-red-400" />
              )}
            </div>
          </div>
        ))}
      </div>

      {preCheck.has_errors && (
        <div className="flex items-center gap-2 p-3 rounded bg-red-900/20 border border-red-800/40 text-red-400 text-sm">
          <XCircle size={16} />
          存在错误，请修复后重试
        </div>
      )}

      <div className="flex justify-between pt-2">
        <button
          onClick={onPrev}
          className="px-4 py-2 text-sm bg-[#1a2639] hover:bg-[#253347] rounded border border-[#253347] text-[#c8daea] transition-colors"
        >
          {preCheck.has_errors ? '返回修改' : '上一步'}
        </button>
        {!preCheck.has_errors && (
          <button
            onClick={onStart}
            className="bg-[#00c9a7] hover:bg-[#00b093] text-[#0d1117] rounded px-5 py-2 text-sm font-semibold transition-colors"
          >
            开始迁移
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Step 4: Migration Progress ───────────────────────────────────────────────

function statusBadge(status: MigrationTask['status']) {
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: '待开始', cls: 'bg-[#1e2d42] text-[#7a9bb8] border-[#253347]' },
    running: { label: '运行中', cls: 'bg-blue-900/40 text-blue-400 border-blue-800/50' },
    paused: { label: '已暂停', cls: 'bg-yellow-900/40 text-yellow-400 border-yellow-800/50' },
    done: { label: '已完成', cls: 'bg-green-900/40 text-[#00c9a7] border-green-800/50' },
    failed: { label: '失败', cls: 'bg-red-900/40 text-red-400 border-red-800/50' },
  };
  const { label, cls } = map[status] ?? map.pending;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs border ${cls}`}>
      {label}
    </span>
  );
}

interface HistoryModalProps {
  tasks: MigrationTask[];
  onClose: () => void;
}

function HistoryModal({ tasks, onClose }: HistoryModalProps) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#111922] border border-[#1e2d42] rounded-lg w-[640px] max-h-[70vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#1e2d42]">
          <h3 className="text-white font-semibold text-sm">迁移任务历史</h3>
          <button onClick={onClose} className="text-[#7a9bb8] hover:text-white transition-colors">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto flex-1">
          {tasks.length === 0 ? (
            <div className="px-5 py-8 text-center text-[#4a6a8a] text-sm">暂无历史任务</div>
          ) : (
            tasks.map((task) => (
              <div
                key={task.id}
                className="flex items-center gap-3 px-5 py-3 border-b border-[#1e2d42] last:border-b-0 hover:bg-[#1a2639]/30"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[#c8daea] text-sm font-medium truncate">{task.name}</span>
                    {statusBadge(task.status)}
                  </div>
                  <div className="text-[#7a9bb8] text-xs mt-0.5">
                    {task.config.tables.length} 张表 · 批量 {task.config.batch_size} · {task.created_at}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

interface Step4Props {
  taskId: number;
}

function Step4({ taskId }: Step4Props) {
  const [task, setTask] = useState<MigrationTask | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyTasks, setHistoryTasks] = useState<MigrationTask[]>([]);
  const [startError, setStartError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Start migration on mount
  useEffect(() => {
    invoke<void>('start_migration', { taskId }).catch((err) => {
      setStartError(String(err));
    });
  }, [taskId]);

  // Poll task status
  useEffect(() => {
    const poll = async () => {
      try {
        const t = await invoke<MigrationTask>('get_migration_task', { taskId });
        setTask(t);
        if (t.status === 'done' || t.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch {
        // ignore transient errors
      }
    };
    poll();
    pollRef.current = setInterval(poll, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [taskId]);

  const handlePause = async () => {
    try {
      await invoke('pause_migration', { taskId });
    } catch {
      // ignore
    }
  };

  const handleShowHistory = async () => {
    try {
      const tasks = await invoke<MigrationTask[]>('list_migration_tasks');
      setHistoryTasks(tasks);
    } catch {
      setHistoryTasks([]);
    }
    setHistoryOpen(true);
  };

  const progress = task?.progress;
  const progressPct =
    progress && progress.total_rows > 0
      ? Math.round((progress.done_rows / progress.total_rows) * 100)
      : 0;

  return (
    <div className="flex flex-col gap-5">
      {startError && (
        <div className="p-3 rounded bg-red-900/20 border border-red-800/40 text-red-400 text-sm">
          启动失败: {startError}
        </div>
      )}

      <div className="p-4 rounded bg-[#0d1117] border border-[#1e2d42] flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-[#7a9bb8] text-sm">任务状态</span>
            {task ? statusBadge(task.status) : <span className="text-[#4a6a8a] text-xs">加载中...</span>}
          </div>
          {task?.status === 'running' && (
            <button
              onClick={handlePause}
              className="px-3 py-1.5 text-xs bg-[#1a2639] hover:bg-[#253347] rounded border border-[#253347] text-[#c8daea] transition-colors"
            >
              暂停
            </button>
          )}
        </div>

        {progress && (
          <>
            <div className="flex items-center justify-between text-xs">
              <span className="text-[#7a9bb8]">当前表</span>
              <span className="text-[#c8daea] font-mono">{progress.current_table || '-'}</span>
            </div>

            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-[#7a9bb8]">进度</span>
                <span className="text-[#c8daea]">
                  {progress.done_rows.toLocaleString()} / {progress.total_rows.toLocaleString()} 行
                  {' '}({progressPct}%)
                </span>
              </div>
              <div className="w-full bg-[#1e2d42] rounded-full h-2">
                <div
                  className="h-2 rounded-full bg-[#00c9a7] transition-all duration-500"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>

            <div className="flex items-center justify-between text-xs">
              <span className="text-[#7a9bb8]">错误数</span>
              <span className={progress.error_count > 0 ? 'text-red-400 font-bold' : 'text-[#00c9a7]'}>
                {progress.error_count}
              </span>
            </div>
          </>
        )}

        {!progress && task && (task.status === 'pending' || task.status === 'running') && (
          <div className="flex items-center gap-2 text-[#7a9bb8] text-sm">
            <Loader2 size={14} className="animate-spin text-[#00c9a7]" />
            等待进度数据...
          </div>
        )}

        {task?.status === 'done' && (
          <div className="flex items-center gap-2 text-[#00c9a7] text-sm">
            <CheckCircle size={16} /> 迁移完成
          </div>
        )}

        {task?.status === 'failed' && (
          <div className="flex items-center gap-2 text-red-400 text-sm">
            <XCircle size={16} /> 迁移失败
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <button
          onClick={handleShowHistory}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-[#1a2639] hover:bg-[#253347] rounded border border-[#253347] text-[#c8daea] transition-colors"
        >
          <History size={14} /> 查看任务历史
        </button>
      </div>

      {historyOpen && (
        <HistoryModal tasks={historyTasks} onClose={() => setHistoryOpen(false)} />
      )}
    </div>
  );
}

// ─── Main Wizard ──────────────────────────────────────────────────────────────

export const MigrationWizard: React.FC = () => {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  // Step 1 state
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(false);
  const [name, setName] = useState('');
  const [srcId, setSrcId] = useState<number | null>(null);
  const [dstId, setDstId] = useState<number | null>(null);
  const [batchSize, setBatchSize] = useState(500);
  const [skipErrors, setSkipErrors] = useState(true);

  // Step 2 state
  const [tables, setTables] = useState<{ src_table: string; dst_table: string }[]>([]);
  const [step2Loading, setStep2Loading] = useState(false);

  // Step 3 state
  const [preCheck, setPreCheck] = useState<PreCheckResult | null>(null);

  // Step 4 state
  const [taskId, setTaskId] = useState<number | null>(null);

  // Load connections on mount
  useEffect(() => {
    setLoadingConnections(true);
    invoke<Connection[]>('list_connections')
      .then((list) => setConnections(list))
      .catch(() => setConnections([]))
      .finally(() => setLoadingConnections(false));
  }, []);

  const handleStep1Next = () => {
    setStep(2);
  };

  const handleStep2Next = async () => {
    if (srcId === null || dstId === null) return;
    setStep2Loading(true);
    try {
      const config: MigrationConfig = {
        tables,
        batch_size: batchSize,
        skip_errors: skipErrors,
      };
      const task = await invoke<MigrationTask>('create_migration_task', {
        name,
        srcConnectionId: srcId,
        dstConnectionId: dstId,
        config,
      });
      const result = await invoke<PreCheckResult>('run_migration_precheck', { taskId: task.id });
      setTaskId(task.id);
      setPreCheck(result);
      setStep(3);
    } catch {
      // Could show an error toast here; for now silently stop loading
    } finally {
      setStep2Loading(false);
    }
  };

  const handleStep3Start = () => {
    setStep(4);
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#111922] overflow-hidden">
      {/* Header */}
      <div className="flex items-center px-6 py-4 border-b border-[#1e2d42] flex-shrink-0">
        <h2 className="text-white font-semibold text-base">数据迁移向导</h2>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-8">
          <StepIndicator step={step} />

          {step === 1 && (
            <Step1
              name={name}
              setName={setName}
              srcId={srcId}
              setSrcId={setSrcId}
              dstId={dstId}
              setDstId={setDstId}
              batchSize={batchSize}
              setBatchSize={setBatchSize}
              skipErrors={skipErrors}
              setSkipErrors={setSkipErrors}
              onNext={handleStep1Next}
              connections={connections}
              loadingConnections={loadingConnections}
            />
          )}

          {step === 2 && (
            <Step2
              tables={tables}
              setTables={setTables}
              onPrev={() => setStep(1)}
              onNext={handleStep2Next}
              loading={step2Loading}
            />
          )}

          {step === 3 && preCheck && (
            <Step3
              preCheck={preCheck}
              onPrev={() => setStep(2)}
              onStart={handleStep3Start}
            />
          )}

          {step === 4 && taskId !== null && (
            <Step4 taskId={taskId} />
          )}
        </div>
      </div>
    </div>
  );
};
