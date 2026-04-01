import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useTaskStore } from '../../store/taskStore';
import { TaskItem } from './TaskItem';
import { useConfirm } from '../../hooks/useConfirm';

type TabFilter = 'all' | 'running' | 'completed' | 'failed';

export const TaskCenter: React.FC = () => {
  const { t } = useTranslation();
  const { tasks, loadTasks, clearCompleted } = useTaskStore();
  const confirm = useConfirm();
  const [filter, setFilter] = React.useState<TabFilter>('all');

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const filteredTasks = React.useMemo(() => {
    if (filter === 'all') return tasks;
    return tasks.filter((task) => task.status === filter);
  }, [tasks, filter]);

  const counts = React.useMemo(() => ({
    all: tasks.length,
    running: tasks.filter((t) => t.status === 'running').length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
  }), [tasks]);

  const handleClearCompleted = async () => {
    if (await confirm({ message: t('taskCenter.clearConfirm') })) {
      await clearCompleted();
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[var(--background-panel)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-default)] flex-shrink-0">
        <h2 className="text-white font-semibold text-base">{t('activity.myTasks')}</h2>
        <button
          onClick={handleClearCompleted}
          className="text-xs text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] transition-colors px-3 py-1.5 bg-[var(--background-hover)] hover:bg-[var(--border-strong)] rounded border border-[var(--border-strong)]"
        >
          {t('taskCenter.clearCompleted')}
        </button>
      </div>

      {/* Filter Tabs */}
      <div className="flex border-b border-[var(--border-default)] flex-shrink-0 px-6">
        {(['all', 'running', 'completed', 'failed'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            className={`px-4 py-2.5 text-sm transition-colors ${
              filter === tab
                ? 'text-[var(--accent)] border-b-2 border-[var(--accent)]'
                : 'text-[var(--foreground-muted)] hover:text-[var(--foreground-default)]'
            }`}
          >
            {t(`taskCenter.tab.${tab}`)}
            {counts[tab] > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 bg-[var(--background-hover)] rounded-full text-xs">
                {counts[tab]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Task List */}
      <div className="flex-1 overflow-y-auto p-6">
        {filteredTasks.length === 0 ? (
          <div className="text-center text-[var(--foreground-muted)] text-sm py-16">
            {t('taskCenter.empty')}
          </div>
        ) : (
          <div className="flex gap-3">
            {[0, 1].map((colIndex) => (
              <div key={colIndex} className="flex-1 flex flex-col gap-3">
                {filteredTasks
                  .filter((_, i) => i % 2 === colIndex)
                  .map((task) => (
                    <TaskItem key={task.id} task={task} />
                  ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
