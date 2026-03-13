import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// 任务类型
export type TaskType = 'export' | 'import' | 'migration' | 'seatunnel';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

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
}

interface TaskState {
  tasks: Task[];
  visible: boolean;
  isLoading: boolean;

  // Actions
  setVisible: (visible: boolean) => void;
  loadTasks: () => Promise<void>;
  addTask: (task: Omit<Task, 'id' | 'startTime'>) => Promise<string>;
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
      const tasks: Task[] = (raw || []).map((r) => ({
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
      }));
      set({ tasks, isLoading: false });
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
    set((s) => ({
      tasks: s.tasks.map((t) => {
        if (t.id !== event.task_id) return t;

        return {
          ...t,
          status: event.status,
          progress: event.progress,
          processedRows: event.processed_rows,
          totalRows: event.total_rows,
          currentTarget: event.current_target,
          error: event.error,
          outputPath: event.output_path,
          endTime: event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled'
            ? new Date().toISOString()
            : null,
        };
      }),
    }));
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
