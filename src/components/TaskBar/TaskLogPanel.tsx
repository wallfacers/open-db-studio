import React, { useEffect, useRef, useState } from 'react';
import { X, ChevronDown, ChevronRight, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useBgTaskStore } from '../../store';
import type { BackgroundTask, TaskLog } from '../../store';

// ---------------------------------------------------------------------------
// Single task card
// ---------------------------------------------------------------------------

interface TaskCardProps {
  task: BackgroundTask;
}

const TaskCard: React.FC<TaskCardProps> = ({ task }) => {
  const removeTask = useBgTaskStore((s) => s.removeTask);
  const [expanded, setExpanded] = useState(task.status === 'running');
  const logEndRef = useRef<HTMLDivElement>(null);

  // Keep running tasks expanded; completed tasks start collapsed
  useEffect(() => {
    if (task.status === 'running') {
      setExpanded(true);
    }
  }, [task.status]);

  // Auto-scroll to the latest log line while running
  useEffect(() => {
    if (task.status === 'running' && expanded) {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [task.logs.length, task.status, expanded]);

  const statusIcon = () => {
    if (task.status === 'running') {
      return <Loader2 size={13} className="animate-spin text-[#00c9a7] flex-shrink-0" />;
    }
    if (task.status === 'success') {
      return <CheckCircle2 size={13} className="text-[#00c9a7] flex-shrink-0" />;
    }
    return <AlertTriangle size={13} className="text-[#f87171] flex-shrink-0" />;
  };

  const chevron = expanded
    ? <ChevronDown size={12} className="text-[#4a6a8a]" />
    : <ChevronRight size={12} className="text-[#4a6a8a]" />;

  const finishedTime = task.finishedAt
    ? new Date(task.finishedAt).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    : null;

  const logLevelClass = (level: TaskLog['level']) => {
    if (level === 'warn') return 'text-[#f59e0b]';
    if (level === 'error') return 'text-[#f87171]';
    return 'text-[#7a9bb8]';
  };

  return (
    <div className="border border-[#1e2d42] rounded mb-2 overflow-hidden">
      {/* Title bar */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 bg-[#0d1117] cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
      >
        {chevron}
        {statusIcon()}
        <span className="flex-1 text-[#c8daea] text-[12px] truncate">{task.title}</span>
        {finishedTime && (
          <span className="text-[#4a6a8a] text-[11px] flex-shrink-0">{finishedTime}</span>
        )}
        {task.status !== 'running' && (
          <button
            className="ml-1 text-[#4a6a8a] hover:text-[#f87171] flex-shrink-0 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              removeTask(task.id);
            }}
            title="关闭"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* Log area */}
      {expanded && (
        <div className="bg-[#050a0e] max-h-40 overflow-y-auto px-3 py-2 font-mono text-[11px]">
          {task.logs.length === 0 ? (
            <span className="text-[#4a6a8a]">等待日志…</span>
          ) : (
            task.logs.map((log, idx) => (
              <div key={idx} className="flex gap-2 leading-5">
                <span className="text-[#4a6a8a] flex-shrink-0">
                  {new Date(log.timestamp).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                  })}
                </span>
                <span className={logLevelClass(log.level)}>{log.message}</span>
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface TaskLogPanelProps {
  onClose?: () => void;
}

export const TaskLogPanel: React.FC<TaskLogPanelProps> = ({ onClose: _onClose }) => {
  const tasks = useBgTaskStore((s) => s.tasks);
  const clearCompleted = useBgTaskStore((s) => s.clearCompleted);

  const completedCount = tasks.filter((t) => t.status !== 'running').length;

  return (
    <div
      className="bg-[#080d12] border border-[#1e2d42] flex flex-col"
      style={{ height: 320 }}
    >
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#0d1117] border-b border-[#1e2d42] flex-shrink-0">
        <span className="text-[#c8daea] text-[12px] font-medium">后台任务</span>
        <button
          className="text-[11px] text-[#4a6a8a] hover:text-[#c8daea] transition-colors disabled:opacity-40"
          onClick={clearCompleted}
          disabled={completedCount === 0}
        >
          清除已完成
        </button>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {tasks.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[#4a6a8a] text-[12px]">
            暂无任务
          </div>
        ) : (
          tasks.map((task) => <TaskCard key={task.id} task={task} />)
        )}
      </div>
    </div>
  );
};
