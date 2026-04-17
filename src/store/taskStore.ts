import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// 任务类型
export type TaskType = 'export' | 'import' | 'migration' | 'ai_generate_metrics' | 'build_schema_graph';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

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
  logs?: TaskLog[];          // 运行时追加到内存，完成后持久化到 SQLite
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
  // 缓冲在任务 stub 加入 store 之前到达的事件，防止早期事件丢失
  _eventBuffer: Record<string, TaskProgressEvent[]>;

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
  _addTaskStub: (task: Task) => void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  visible: false,
  isLoading: false,
  _eventBuffer: {},

  setVisible: (visible) => set({ visible }),

  loadTasks: async () => {
    set({ isLoading: true });
    try {
      const raw = await invoke<any[]>('get_task_list', { limit: 100 });
      const rows: Task[] = (raw || []).map((r) => {
        // 从 SQLite 恢复日志（JSON 数组字符串 → TaskLog[]）
        let persistedLogs: TaskLog[] | undefined;
        if (r.logs) {
          try {
            const parsed = typeof r.logs === 'string' ? JSON.parse(r.logs) : r.logs;
            if (Array.isArray(parsed)) {
              persistedLogs = parsed.map((l: any) => ({
                timestamp: l.timestamp_ms ?? l.timestamp ?? Date.now(),
                level: l.level ?? 'info',
                message: l.message ?? '',
              }));
            }
          } catch { /* 解析失败忽略 */ }
        }
        return {
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
          metricCount: r.metric_count ?? r.metricCount ?? undefined,
          skippedCount: r.skipped_count ?? r.skippedCount ?? undefined,
          logs: persistedLogs,
        };
      });
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
          const memExtras: Partial<Task> = {};
          // 运行中任务：保留内存实时进度和日志（SQLite 只在完成时写入）
          if (row.status === 'running') {
            if (existing.progress > (row.progress ?? 0)) {
              memExtras.progress = existing.progress;
              if (existing.currentTarget) memExtras.currentTarget = existing.currentTarget;
            }
            if (existing.logs?.length) memExtras.logs = existing.logs;
          }
          return { ...row, progress, ...memExtras };
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

  _addTaskStub: (task) => {
    set((s) => {
      if (s.tasks.some((t) => t.id === task.id)) return s;
      return { tasks: [task, ...s.tasks] };
    });
    // 回放因任务尚未进入 store 而被缓冲的早期事件
    const buffered = get()._eventBuffer[task.id];
    if (buffered?.length) {
      set((s) => ({ _eventBuffer: { ...s._eventBuffer, [task.id]: [] } }));
      buffered.forEach((e) => get()._handleProgressEvent(e));
    }
  },

  _handleProgressEvent: (event) => {
    // 任务 stub 尚未进入 store（invoke 返回前后端已开始 emit）→ 缓冲，等 _addTaskStub 回放
    if (!get().tasks.some((t) => t.id === event.task_id)) {
      set((s) => ({
        _eventBuffer: {
          ...s._eventBuffer,
          [event.task_id]: [...(s._eventBuffer[event.task_id] ?? []), event],
        },
      }));
      return;
    }

    // 已处于终态（cancelled/completed/failed）的任务：忽略滞后的非终态事件
    // 防止 cancel_task 后后端仍在 emit running 事件导致状态回退、Stop 按钮复现
    const TERMINAL: TaskStatus[] = ['completed', 'failed', 'cancelled'];
    const existing = get().tasks.find((t) => t.id === event.task_id);
    if (existing && TERMINAL.includes(existing.status) && !TERMINAL.includes(event.status)) {
      return;
    }

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
