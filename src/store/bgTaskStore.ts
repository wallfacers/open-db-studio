import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';

export interface TaskLog {
  timestamp: number;   // unix ms
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface BackgroundTask {
  id: string;
  type: 'ai_generate_metrics';
  title: string;          // e.g. "AI 生成指标 · orders_db"
  status: 'running' | 'success' | 'error';
  logs: TaskLog[];
  startedAt: number;
  finishedAt?: number;
  connectionId?: number;  // 供 MetricListPanel 精确匹配
  database?: string;
  schema?: string;
  metricCount?: number;   // 新增数量
  skippedCount?: number;  // 跳过数量
}

interface BgTaskStore {
  tasks: BackgroundTask[];
  addTask: (
    id: string,
    type: BackgroundTask['type'],
    title: string,
    scope: { connectionId: number; database?: string; schema?: string }
  ) => void;
  appendLog: (id: string, log: TaskLog) => void;
  completeTask: (id: string, success: boolean, extra?: Partial<BackgroundTask>) => void;
  removeTask: (id: string) => void;
  clearCompleted: () => void;
}

export const useBgTaskStore = create<BgTaskStore>((set) => ({
  tasks: [],

  addTask: (id, type, title, scope) => {
    const task: BackgroundTask = {
      id,
      type,
      title,
      status: 'running',
      logs: [],
      startedAt: Date.now(),
      connectionId: scope.connectionId,
      database: scope.database,
      schema: scope.schema,
    };
    set((s) => ({ tasks: [task, ...s.tasks] }));
  },

  appendLog: (id, log) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id ? { ...t, logs: [...t.logs, log] } : t
      ),
    }));
  },

  completeTask: (id, success, extra) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id
          ? {
              ...t,
              ...extra,
              status: success ? 'success' : 'error',
              finishedAt: Date.now(),
            }
          : t
      ),
    }));
  },

  removeTask: (id) => {
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
  },

  clearCompleted: () => {
    set((s) => ({
      tasks: s.tasks.filter((t) => t.status === 'running'),
    }));
  },
}));

// ---------------------------------------------------------------------------
// Tauri event listeners — 模块级 guard 防止重复注册
// ---------------------------------------------------------------------------

interface BgTaskLogPayload {
  task_id: string;
  level: string;
  message: string;
  timestamp_ms: number;
}

interface BgTaskDonePayload {
  task_id: string;
  success: boolean;
  error?: string;
  connection_id: number;
  database?: string | null;
  schema?: string | null;
  metric_count?: number;
  skipped_count?: number;
}

let initialized = false;

export function initBgTaskListeners() {
  if (initialized) return;
  initialized = true;

  listen<BgTaskLogPayload>('bg_task_log', (event) => {
    const p = event.payload;
    const log: TaskLog = {
      timestamp: p.timestamp_ms,
      level: (p.level === 'warn' || p.level === 'error') ? p.level : 'info',
      message: p.message,
    };
    useBgTaskStore.getState().appendLog(p.task_id, log);
  });

  listen<BgTaskDonePayload>('bg_task_done', (event) => {
    const p = event.payload;
    if (!p.success && p.error) {
      useBgTaskStore.getState().appendLog(p.task_id, {
        timestamp: Date.now(),
        level: 'error',
        message: p.error,
      });
    }
    useBgTaskStore.getState().completeTask(p.task_id, p.success, {
      metricCount: p.metric_count,
      skippedCount: p.skipped_count,
      connectionId: p.connection_id,
      database: p.database ?? undefined,
      schema: p.schema ?? undefined,
    });
  });
}
