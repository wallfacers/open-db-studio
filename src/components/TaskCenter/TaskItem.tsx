import React, { useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle, XCircle, Square, RotateCcw, Trash2, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Task, useTaskStore } from '../../store/taskStore';
import { useConfirm } from '../../hooks/useConfirm';
import { Tooltip } from '../common/Tooltip';

interface Props {
  task: Task;
}

const statusConfig = {
  pending: { icon: Loader2, color: 'text-[var(--foreground-muted)]', bgColor: 'bg-[var(--foreground-muted)]/20', animate: true },
  running: { icon: Loader2, color: 'text-[var(--info)]', bgColor: 'bg-[var(--info)]/20', animate: true },
  completed: { icon: CheckCircle, color: 'text-[var(--accent)]', bgColor: 'bg-[var(--accent)]/20', animate: false },
  failed: { icon: XCircle, color: 'text-[var(--error)]', bgColor: 'bg-[var(--error)]/20', animate: false },
  cancelled: { icon: Square, color: 'text-[var(--foreground-muted)]', bgColor: 'bg-[var(--foreground-muted)]/20', animate: false },
};

const progressBarColor = {
  pending: 'var(--foreground-muted)',
  running: 'var(--info)',
  completed: 'var(--accent)',
  failed: 'var(--error)',
  cancelled: 'var(--foreground-muted)',
};

export const TaskItem: React.FC<Props> = ({ task }) => {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { cancelTask, retryTask, removeTask } = useTaskStore();
  const [isExpanded, setIsExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isExpanded && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [task.logs, isExpanded]);

  useEffect(() => {
    const isActive = task.status === 'running' || task.status === 'pending';
    if (!isActive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [task.status]);

  const config = statusConfig[task.status];
  const StatusIcon = config.icon;

  const formatDuration = () => {
    const start = new Date(task.startTime).getTime();
    const isFinished = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
    const end = task.endTime
      ? new Date(task.endTime).getTime()
      : isFinished ? start : now;
    const seconds = Math.floor((end - start) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs}s`;
  };

  const handleCancel = async () => {
    if (await confirm({ message: t('taskCenter.cancelConfirm'), variant: 'danger' })) {
      await cancelTask(task.id);
    }
  };

  const handleRetry = async () => {
    await retryTask(task.id);
  };

  const handleRemove = () => {
    removeTask(task.id);
  };

  const handleOpenOutput = () => {
    if (task.outputPath) {
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('show_in_folder', { path: task.outputPath! });
      });
    }
  };

  return (
    <div className="bg-[var(--background-panel)] border border-[var(--border-default)] rounded-lg overflow-hidden">
      {/* Main Row */}
      <div
        className="flex items-center gap-3 p-3 cursor-pointer hover:bg-[var(--background-hover)]/50"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {/* Status Icon */}
        <div className={`${config.bgColor} rounded-full p-1.5`}>
          <StatusIcon
            size={16}
            className={`${config.color} ${config.animate ? 'animate-spin' : ''}`}
          />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm text-[var(--foreground)] truncate">{task.title}</span>
            <span className="text-xs text-[var(--foreground-muted)] ml-2">{formatDuration()}</span>
          </div>

          {/* Progress Bar */}
          {(task.status === 'running' || task.status === 'pending' || task.status === 'completed') && (
            <div className="relative h-1.5 bg-[var(--background-hover)] rounded-full overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 transition-all duration-300"
                style={{
                  width: `${task.status === 'completed' ? 100 : task.progress}%`,
                  backgroundColor: progressBarColor[task.status],
                }}
              />
            </div>
          )}

          {/* Status Text */}
          <div className="text-xs text-[var(--foreground-muted)] mt-1">
            {task.status === 'running' && (
              <>
                {task.progress}% · {task.currentTarget}
                {task.totalRows && ` · ${(task.processedRows ?? 0).toLocaleString()}/${task.totalRows.toLocaleString()} rows`}
              </>
            )}
            {task.status === 'completed' && (
              <>
                {task.type === 'ai_generate_metrics' ? (
                  <>
                    {t('taskCenter.completed', 'Completed')}
                    {task.metricCount != null && <> · <span className="text-[var(--accent)]">新增 {task.metricCount} 个</span></>}
                    {task.skippedCount != null && <> · 跳过 {task.skippedCount} 个</>}
                  </>
                ) : task.type === 'build_schema_graph' ? (
                  <>
                    {t('taskCenter.completed', 'Completed')}
                    {(task.processedRows ?? 0) > 0 && <> · <span className="text-[var(--accent)]">{(task.processedRows ?? 0).toLocaleString()} 张表</span></>}
                  </>
                ) : (
                  <>{t('taskCenter.completed', 'Completed')} · {(task.processedRows ?? 0).toLocaleString()} {t('taskCenter.rows', 'rows')}</>
                )}
              </>
            )}
            {task.status === 'failed' && task.error && (
              <span className="text-[var(--error)]">{task.error}</span>
            )}
            {task.status === 'cancelled' && t('taskCenter.cancelled', 'Cancelled')}
          </div>

          {/* Time Info */}
          <div className="flex gap-3 mt-1.5 text-xs text-[var(--foreground-subtle)]">
            <span>
              <span className="text-[var(--foreground-ghost)]">{t('taskCenter.startTime', '开始')}：</span>
              {new Date(task.startTime).toLocaleString()}
            </span>
            {task.endTime && (
              <span>
                <span className="text-[var(--foreground-ghost)]">{t('taskCenter.endTime', '结束')}：</span>
                {new Date(task.endTime).toLocaleString()}
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {task.status === 'running' && (
            <Tooltip content={t('taskCenter.cancel', 'Cancel')} className="contents">
              <button
                onClick={handleCancel}
                className="p-1.5 text-[var(--foreground-muted)] hover:text-[var(--error)] transition-colors"
              >
                <Square size={14} />
              </button>
            </Tooltip>
          )}
          {(task.status === 'failed' || task.status === 'cancelled') && task.type !== 'ai_generate_metrics' && (
            <Tooltip content={t('taskCenter.retry', 'Retry')} className="contents">
              <button
                onClick={handleRetry}
                className="p-1.5 text-[var(--foreground-muted)] hover:text-[var(--accent)] transition-colors"
              >
                <RotateCcw size={14} />
              </button>
            </Tooltip>
          )}
          {task.status === 'completed' && task.outputPath && (
            <Tooltip content={t('taskCenter.openOutput', 'Open output')} className="contents">
              <button
                onClick={handleOpenOutput}
                className="p-1.5 text-[var(--foreground-muted)] hover:text-[var(--info)] transition-colors"
              >
                <ExternalLink size={14} />
              </button>
            </Tooltip>
          )}
          {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') && (
            <Tooltip content={t('taskCenter.remove', 'Remove')} className="contents">
              <button
                onClick={handleRemove}
                className="p-1.5 text-[var(--foreground-muted)] hover:text-[var(--error)] transition-colors"
              >
                <Trash2 size={14} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="border-t border-[var(--border-default)] p-3 text-xs text-[var(--foreground-muted)]">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-[var(--foreground-subtle)]">{t('taskCenter.taskId', 'Task ID')}:</span> {task.id}
            </div>
            <div>
              <span className="text-[var(--foreground-subtle)]">{t('taskCenter.type', 'Type')}:</span> {task.type}
            </div>
            {task.outputPath && (
              <div className="col-span-2">
                <span className="text-[var(--foreground-subtle)]">{t('taskCenter.outputPath', 'Output')}:</span>{' '}
                <span className="text-[var(--foreground-default)] break-all">{task.outputPath}</span>
              </div>
            )}
          </div>

          {/* ai_generate_metrics 统计 */}
          {task.type === 'ai_generate_metrics' && (task.metricCount != null || task.skippedCount != null) && (
            <div className="mt-2 text-xs text-[var(--foreground-muted)]">
              {task.metricCount != null && <span>新增指标: <span className="text-[var(--accent)]">{task.metricCount}</span></span>}
              {task.skippedCount != null && <span className="ml-3">跳过: <span className="text-[var(--warning)]">{task.skippedCount}</span></span>}
            </div>
          )}

          {/* Markdown 描述（连接/数据库/表清单信息） */}
          {task.description && (
            <div className="mt-3">
              <div className="text-[var(--foreground-subtle)] mb-1.5">{t('taskCenter.taskDesc', '任务详情')}:</div>
              <div className="bg-[var(--background-base)] rounded p-2.5 font-mono text-[var(--foreground-default)] leading-5 whitespace-pre-wrap break-all">
                {task.description}
              </div>
            </div>
          )}

          {/* Error Details */}
          {task.status === 'failed' && task.errorDetails?.length > 0 && (
            <div className="mt-3">
              <div className="text-[var(--foreground-subtle)] mb-1">{t('taskCenter.errorDetails', 'Error Details')}:</div>
              <div className="bg-[var(--background-base)] rounded p-2 max-h-32 overflow-y-auto font-mono text-[var(--error)]">
                {task.errorDetails.map((err, i) => (
                  <div key={i}>{err}</div>
                ))}
              </div>
            </div>
          )}

          {/* 任务日志区域 */}
          {(task.type === 'ai_generate_metrics' || task.type === 'build_schema_graph') && task.logs && task.logs.length > 0 && (
            <div className="mt-3">
              <div className="text-[var(--foreground-subtle)] mb-1">日志</div>
              <div className="bg-[var(--background-base)] rounded p-2 max-h-48 overflow-y-auto font-mono text-xs leading-5">
                {task.logs.map((log, i) => (
                  <div key={i} className={
                    log.level === 'error' ? 'text-[var(--error)]' :
                    log.level === 'warn' ? 'text-[var(--warning)]' :
                    'text-[var(--foreground-default)]'
                  }>
                    [{new Date(log.timestamp).toLocaleTimeString()}] {log.level.toUpperCase()} {log.message}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          )}

          {/* 问 AI 分析 */}
          {task.status === 'failed' && (
            <div className="mt-3 pt-3 border-t border-[var(--border-default)]">
              <button
                onClick={() => {
                  Promise.all([
                    import('../../utils/askAi'),
                    import('../../utils/errorContext'),
                  ]).then(([{ askAiWithContext }, { buildErrorContext }]) => {
                    const ctx = buildErrorContext('export', {
                      rawError: task.error ?? '未知错误',
                      taskDescription: task.description ?? undefined,
                      taskErrorDetails: task.errorDetails ?? [],
                      processedRows: task.processedRows,
                      totalRows: task.totalRows ?? undefined,
                    });
                    if (ctx.markdownContext) {
                      askAiWithContext(ctx.markdownContext);
                    }
                  });
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[var(--background-hover)] hover:bg-[var(--border-strong)] text-[var(--foreground-muted)] hover:text-[var(--accent)] rounded border border-[var(--border-strong)] transition-colors"
              >
                🤖 {t('error.askAiAnalyze', '问 AI 分析失败原因')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
