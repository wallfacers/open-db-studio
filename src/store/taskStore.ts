import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// 任务类型
export type TaskType = 'export' | 'import' | 'migration' | 'seatunnel' | 'ai_generate_metrics';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// 内存日志条目（不写 SQLite，重启清空）
export interface TaskLog {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

// 单个任务记录
export interface Task {
  id: string;
  type: TaskType;
  status: TaskStatus;
  title: string;
  progress: number;           // 0-100
  processedRows: number;
  totalRows: number | null;
  currentTarget: string;      // 当前处理的表名
  error: string | null;
  errorDetails: string[];     // 失败行详情
  outputPath: string | null;
  description: string | null; // Markdown 格式任务描述
  startTime: string;          // ISO 8601
  endTime: string | null;
  logs?: TaskLog[];          // 内存日志，不写 SQLite，重启清空
  connectionId?: number;    // scope（ai_generate_metrics 专用）
  database?: string;
  schema?: string;
  metricCount?: number;
  skippedCount?: number;
}

// 进度更新事件
export interface TaskProgressEvent {
  task_id: string;
  status: TaskStatus;
  progress: number;
  processed_rows: number;
  total_rows: number | null;
  current_target: string;
  error: string | null;
  output_path: string | null;
  log_line?: { level: string; message: string; timestamp_ms: number };
  connection_id?: number;
  database?: string | null;
  schema?: string | null;
  metric_count?: number;
  skipped_count?: number;
}

interface TaskState {
  tasks: Task[];
  visible: boolean;
  isLoading: boolean;

  // Actions
  setVisible: (visible: boolean) => void;
  loadTasks: () => Promise<void>;
  addTask: (task: Omit<Task, 'id' | 'startTime'>) => Promise<string>;
  appendLog: (id: string, log: TaskLog) => void;
  updateTask: (id: string, updates: Partial<Task>) => void;
  cancelTask: (id: string) => Promise<void>;
  retryTask: (id: string) => Promise<void>;
  removeTask: (id: string) => void;
  clearCompleted: () => Promise<void>;

  // 内部方法
  _handleProgressEvent: (event: TaskProgressEvent) => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  visible: false,
  isLoading: false,

  setVisible: (visible) => set({ visible }),

  loadTasks: async () => {
    set({ isLoading: true });
    try {
      const raw = await invoke<any[]>('get_task_list', { limit: 100 });
      const rows: Task[] = (raw || []).map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        title: r.title,
        progress: r.progress ?? 0,
        processedRows: r.processed_rows ?? r.processedRows ?? 0,
        totalRows: r.total_rows ?? r.totalRows ?? null,
        currentTarget: r.current_target ?? r.currentTarget ?? '',
        error: r.error ?? null,
        errorDetails: r.error_details
          ? (typeof r.error_details === 'string' ? JSON.parse(r.error_details) : r.error_details)
          : (r.errorDetails ?? []),
        outputPath: r.output_path ?? r.outputPath ?? null,
        description: r.description ?? null,
        startTime: r.created_at ?? r.start_time ?? r.startTime ?? new Date().toISOString(),
        endTime: r.completed_at ?? r.end_time ?? r.endTime ?? null,
        connectionId: r.connection_id ?? r.connectionId ?? undefined,
        database: r.scope_database ?? r.database ?? undefined,
        schema: r.scope_schema ?? r.schema ?? undefined,
      }));
      const TERMINAL: TaskStatus[] = ['completed', 'failed', 'cancelled'];
      set((state) => ({
        tasks: rows.map((row) => {
          const existing = state.tasks.find((t) => t.id === row.id);
          if (!existing) return row;
          // 内存已达终态但 SQLite 尚未落盘（异步写入窗口）→ 保留内存状态
          if (TERMINAL.includes(existing.status) && !TERMINAL.includes(row.status as TaskStatus)) {
            return existing;
          }
          // completed 但 SQLite progress 未及时更新 → 保证显示 100
          const progress = row.status === 'completed' && !row.progress ? 100 : row.progress;
          // 其余以 SQLite 为准，保留内存日志
          return { ...row, progress, ...(existing.logs?.length ? { logs: existing.logs } : {}) };
        }),
        isLoading: false,
      }));
    } catch (e) {
      console.error('Failed to load tasks:', e);
      set({ isLoading: false });
    }
  },

  addTask: async (task) => {
    const record = await invoke<{ id: string }>('create_task', {
      task: {
        type: task.type,
        status: task.status || 'pending',
        title: task.title,
        params: null, // 由调用方传入
        progress: task.progress || 0,
        processed_rows: task.processedRows || 0,
        total_rows: task.totalRows,
        current_target: task.currentTarget || '',
        error: task.error,
        error_details: task.errorDetails ? JSON.stringify(task.errorDetails) : null,
        output_path: task.outputPath,
        connection_id: (task as any).connectionId ?? null,
        scope_database: (task as any).database ?? null,
        scope_schema: (task as any).schema ?? null,
      }
    });
    const id = record.id;

    const newTask: Task = {
      ...task,
      id,
      description: task.description ?? null,
      startTime: new Date().toISOString(),
    };
    set((s) => ({ tasks: [newTask, ...s.tasks] }));
    return id;
  },

  appendLog: (id, log) =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id ? { ...t, logs: [...(t.logs ?? []), log] } : t
      ),
    })),

  updateTask: (id, updates) => {
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    }));
  },

  cancelTask: async (id) => {
    try {
      await invoke('cancel_task', { taskId: id });
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === id ? { ...t, status: 'cancelled' as TaskStatus, endTime: new Date().toISOString() } : t
        ),
      }));
    } catch (e) {
      console.error('Failed to cancel task:', e);
      throw e;
    }
  },

  retryTask: async (id) => {
    try {
      await invoke('retry_task', { taskId: id });
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === id ? { ...t, status: 'pending' as TaskStatus, progress: 0, error: null } : t
        ),
      }));
    } catch (e) {
      console.error('Failed to retry task:', e);
      throw e;
    }
  },

  removeTask: (id) => {
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
    // 同步到后端
    invoke('delete_task', { id }).catch(console.error);
  },

  clearCompleted: async () => {
    const completedIds = get().tasks
      .filter((t) => t.status === 'completed' || t.status === 'cancelled')
      .map((t) => t.id);

    set((s) => ({
      tasks: s.tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled'),
    }));

    // 同步到后端
    for (const id of completedIds) {
      await invoke('delete_task', { id }).catch(console.error);
    }
  },

  _handleProgressEvent: (event) => {
    // 日志事件：只追加日志，不更新进度字段
    if (event.log_line) {
      get().appendLog(event.task_id, {
        timestamp: event.log_line.timestamp_ms,
        level: event.log_line.level as TaskLog['level'],
        message: event.log_line.message,
      });
      return;
    }

    const updates: Partial<Task> = {
      status: event.status,
      progress: event.progress,
      processedRows: event.processed_rows,
      totalRows: event.total_rows,
      currentTarget: event.current_target,
      error: event.error,
      outputPath: event.output_path,
    };

    if (event.status === 'completed' || event.status === 'failed') {
      updates.endTime = new Date().toISOString();
      if (event.metric_count != null) updates.metricCount = event.metric_count;
      if (event.skipped_count != null) updates.skippedCount = event.skipped_count;
    } else if (event.status !== 'cancelled') {
      updates.endTime = null;
    }

    if (event.status === 'cancelled') {
      updates.endTime = new Date().toISOString();
    }

    get().updateTask(event.task_id, updates);
  },
}));

// 初始化时监听后端进度事件
let initialized = false;
export function initTaskProgressListener() {
  if (initialized) return;
  initialized = true;

  listen<TaskProgressEvent>('task-progress', (event) => {
    useTaskStore.getState()._handleProgressEvent(event.payload);
  });
}
