import React, { useState } from 'react';
import { Loader2, CheckCircle, XCircle, Square, RotateCcw, Trash2, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Task, useTaskStore } from '../../store/taskStore';
import { useConfirm } from '../../hooks/useConfirm';

interface Props {
  task: Task;
}

const statusConfig = {
  pending: { icon: Loader2, color: 'text-[#7a9bb8]', bgColor: 'bg-[#7a9bb8]/20', animate: true },
  running: { icon: Loader2, color: 'text-[#3794ff]', bgColor: 'bg-[#3794ff]/20', animate: true },
  completed: { icon: CheckCircle, color: 'text-[#00c9a7]', bgColor: 'bg-[#00c9a7]/20', animate: false },
  failed: { icon: XCircle, color: 'text-[#f44747]', bgColor: 'bg-[#f44747]/20', animate: false },
  cancelled: { icon: Square, color: 'text-[#7a9bb8]', bgColor: 'bg-[#7a9bb8]/20', animate: false },
};

const progressBarColor = {
  pending: '#7a9bb8',
  running: '#3794ff',
  completed: '#00c9a7',
  failed: '#f44747',
  cancelled: '#7a9bb8',
};

export const TaskItem: React.FC<Props> = ({ task }) => {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { cancelTask, retryTask, removeTask } = useTaskStore();
  const [isExpanded, setIsExpanded] = useState(false);

  const config = statusConfig[task.status];
  const StatusIcon = config.icon;

  const formatDuration = () => {
    const start = new Date(task.startTime).getTime();
    const isFinished = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
    const end = task.endTime
      ? new Date(task.endTime).getTime()
      : isFinished ? start : Date.now();
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
    <div className="bg-[#111922] border border-[#1e2d42] rounded-lg overflow-hidden">
      {/* Main Row */}
      <div
        className="flex items-center gap-3 p-3 cursor-pointer hover:bg-[#1a2639]/50"
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
            <span className="text-sm text-[#e8f4ff] truncate">{task.title}</span>
            <span className="text-xs text-[#7a9bb8] ml-2">{formatDuration()}</span>
          </div>

          {/* Progress Bar */}
          {(task.status === 'running' || task.status === 'pending') && (
            <div className="relative h-1.5 bg-[#1a2639] rounded-full overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 transition-all duration-300"
                style={{
                  width: `${task.progress}%`,
                  backgroundColor: progressBarColor[task.status],
                }}
              />
            </div>
          )}

          {/* Status Text */}
          <div className="text-xs text-[#7a9bb8] mt-1">
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
                    {task.metricCount != null && <> · <span className="text-[#00c9a7]">新增 {task.metricCount} 个</span></>}
                    {task.skippedCount != null && <> · 跳过 {task.skippedCount} 个</>}
                  </>
                ) : (
                  <>{t('taskCenter.completed', 'Completed')} · {(task.processedRows ?? 0).toLocaleString()} {t('taskCenter.rows', 'rows')}</>
                )}
              </>
            )}
            {task.status === 'failed' && task.error && (
              <span className="text-[#f44747]">{task.error}</span>
            )}
            {task.status === 'cancelled' && t('taskCenter.cancelled', 'Cancelled')}
          </div>

          {/* Time Info */}
          <div className="flex gap-3 mt-1.5 text-xs text-[#5a7a9a]">
            <span>
              <span className="text-[#3a5a7a]">{t('taskCenter.startTime', '开始')}：</span>
              {new Date(task.startTime).toLocaleString()}
            </span>
            {task.endTime && (
              <span>
                <span className="text-[#3a5a7a]">{t('taskCenter.endTime', '结束')}：</span>
                {new Date(task.endTime).toLocaleString()}
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {task.status === 'running' && (
            <button
              onClick={handleCancel}
              className="p-1.5 text-[#7a9bb8] hover:text-[#f44747] transition-colors"
              title={t('taskCenter.cancel', 'Cancel')}
            >
              <Square size={14} />
            </button>
          )}
          {(task.status === 'failed' || task.status === 'cancelled') && task.type !== 'ai_generate_metrics' && (
            <button
              onClick={handleRetry}
              className="p-1.5 text-[#7a9bb8] hover:text-[#00c9a7] transition-colors"
              title={t('taskCenter.retry', 'Retry')}
            >
              <RotateCcw size={14} />
            </button>
          )}
          {task.status === 'completed' && task.outputPath && (
            <button
              onClick={handleOpenOutput}
              className="p-1.5 text-[#7a9bb8] hover:text-[#3794ff] transition-colors"
              title={t('taskCenter.openOutput', 'Open output')}
            >
              <ExternalLink size={14} />
            </button>
          )}
          {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') && (
            <button
              onClick={handleRemove}
              className="p-1.5 text-[#7a9bb8] hover:text-[#f44747] transition-colors"
              title={t('taskCenter.remove', 'Remove')}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="border-t border-[#1e2d42] p-3 text-xs text-[#7a9bb8]">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-[#5a7a9a]">{t('taskCenter.taskId', 'Task ID')}:</span> {task.id}
            </div>
            <div>
              <span className="text-[#5a7a9a]">{t('taskCenter.type', 'Type')}:</span> {task.type}
            </div>
            {task.outputPath && (
              <div className="col-span-2">
                <span className="text-[#5a7a9a]">{t('taskCenter.outputPath', 'Output')}:</span>{' '}
                <span className="text-[#c8daea] break-all">{task.outputPath}</span>
              </div>
            )}
          </div>

          {/* ai_generate_metrics 统计 */}
          {task.type === 'ai_generate_metrics' && (task.metricCount != null || task.skippedCount != null) && (
            <div className="mt-2 text-xs text-[#7a9bb8]">
              {task.metricCount != null && <span>新增指标: <span className="text-[#00c9a7]">{task.metricCount}</span></span>}
              {task.skippedCount != null && <span className="ml-3">跳过: <span className="text-[#ffcc00]">{task.skippedCount}</span></span>}
            </div>
          )}

          {/* Markdown 描述（连接/数据库/表清单信息） */}
          {task.description && (
            <div className="mt-3">
              <div className="text-[#5a7a9a] mb-1.5">{t('taskCenter.taskDesc', '任务详情')}:</div>
              <div className="bg-[#0d1117] rounded p-2.5 font-mono text-[#8ab4d4] leading-5 whitespace-pre-wrap break-all">
                {task.description}
              </div>
            </div>
          )}

          {/* Error Details */}
          {task.status === 'failed' && task.errorDetails?.length > 0 && (
            <div className="mt-3">
              <div className="text-[#5a7a9a] mb-1">{t('taskCenter.errorDetails', 'Error Details')}:</div>
              <div className="bg-[#0d1117] rounded p-2 max-h-32 overflow-y-auto font-mono text-[#f44747]">
                {task.errorDetails.map((err, i) => (
                  <div key={i}>{err}</div>
                ))}
              </div>
            </div>
          )}

          {/* 任务日志区域 */}
          {(task.type === 'ai_generate_metrics' || task.type === 'build_schema_graph') && task.logs && task.logs.length > 0 && (
            <div className="mt-3">
              <div className="text-[#5a7a9a] mb-1">日志</div>
              <div className="bg-[#0d1117] rounded p-2 max-h-48 overflow-y-auto font-mono text-xs leading-5">
                {task.logs.map((log, i) => (
                  <div key={i} className={
                    log.level === 'error' ? 'text-[#f44747]' :
                    log.level === 'warn' ? 'text-[#ffcc00]' :
                    'text-[#8ab4d4]'
                  }>
                    [{new Date(log.timestamp).toLocaleTimeString()}] {log.level.toUpperCase()} {log.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 问 AI 分析 */}
          {task.status === 'failed' && (
            <div className="mt-3 pt-3 border-t border-[#1e2d42]">
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
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#1a2639] hover:bg-[#253347] text-[#7a9bb8] hover:text-[#00c9a7] rounded border border-[#253347] transition-colors"
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
