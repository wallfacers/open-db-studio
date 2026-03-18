import React, { useState } from 'react';
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useBgTaskStore } from '../../store';
import { TaskLogPanel } from './TaskLogPanel';

export const TaskBar: React.FC = () => {
  const tasks = useBgTaskStore((s) => s.tasks);
  const [isOpen, setIsOpen] = useState(false);

  // Derive display state
  const runningTasks = tasks.filter((t) => t.status === 'running');
  const failedTasks = tasks.filter((t) => t.status === 'error');
  const successTasks = tasks.filter((t) => t.status === 'success');

  const hasRunning = runningTasks.length > 0;
  const hasFailed = failedTasks.length > 0;
  const hasSuccess = successTasks.length > 0;

  // Latest finished task timestamp (success or error)
  const lastFinishedAt = tasks
    .filter((t) => t.finishedAt !== undefined)
    .reduce<number>((max, t) => Math.max(max, t.finishedAt!), 0);

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

  const renderStatus = () => {
    if (hasRunning) {
      return (
        <span className="flex items-center gap-1.5 text-[#00c9a7]">
          <Loader2 size={12} className="animate-spin" />
          <span>{runningTasks.length} 个任务运行中</span>
        </span>
      );
    }
    if (hasFailed) {
      return (
        <span className="flex items-center gap-1.5 text-[#f87171]">
          <AlertTriangle size={12} />
          <span>{failedTasks.length} 个任务失败</span>
        </span>
      );
    }
    if (hasSuccess && lastFinishedAt > 0) {
      return (
        <span className="flex items-center gap-1.5 text-[#00c9a7]">
          <CheckCircle2 size={12} />
          <span>上次任务成功 {formatTime(lastFinishedAt)}</span>
        </span>
      );
    }
    return null;
  };

  const statusContent = renderStatus();

  return (
    <div className="relative flex-shrink-0">
      {/* Log panel — rendered above the status bar */}
      {isOpen && (
        <div className="absolute bottom-full left-0 right-0 z-50">
          <TaskLogPanel />
        </div>
      )}

      {/* Status bar */}
      <div
        className="h-6 bg-[#0d1117] border-t border-[#1e2d42] flex items-center px-3 cursor-pointer select-none"
        onClick={() => {
          if (tasks.length > 0) {
            setIsOpen((v) => !v);
          }
        }}
      >
        <div className="text-[11px]">
          {statusContent}
        </div>
      </div>
    </div>
  );
};
