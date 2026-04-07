import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { User, Database, ListTodo, Activity, Network, Workflow, Settings, ChevronRight, ChevronLeft, Grid3x3, ArrowLeftRight } from 'lucide-react';
import type { ToastLevel } from '../Toast';
import { Tooltip } from '../common/Tooltip';

interface ActivityBarProps {
  activeActivity: string;
  setActiveActivity: (activity: string) => void;
  isSidebarOpen: boolean;
  setIsSidebarOpen: (isOpen: boolean) => void;
  showToast: (msg: string, level?: ToastLevel) => void;
}

export const ActivityBar: React.FC<ActivityBarProps> = ({
  activeActivity,
  setActiveActivity,
  isSidebarOpen,
  setIsSidebarOpen,
  showToast
}) => {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className={`flex flex-col py-2 border-r border-border-default bg-background-base justify-between flex-shrink-0 z-20 transition-all duration-300 ${isExpanded ? 'w-48' : 'w-14'}`}>
      <div className="flex flex-col w-full">
        <div className={`flex items-center justify-between transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} hover:bg-border-default border-l-[3px] border-transparent`}>
          {isExpanded ? (
            <>
              <div
                className="flex items-center cursor-pointer overflow-hidden flex-1"
                onClick={() => showToast(t('activity.openUserProfile'), 'info')}
              >
                <div className="w-6 h-6 rounded-full bg-accent flex items-center justify-center text-foreground mr-3 flex-shrink-0">
                  <User size={14} />
                </div>
                <span className="text-foreground-default text-[13px] truncate">{t('activity.userProfile')}</span>
              </div>
              <Tooltip content={t('activity.collapse')}>
                <div
                  className="flex items-center justify-center cursor-pointer text-foreground-muted hover:text-foreground transition-colors duration-200"
                  onClick={() => setIsExpanded(false)}
                >
                  <ChevronLeft size={20} />
                </div>
              </Tooltip>
            </>
          ) : (
            <Tooltip content={t('activity.expand')}>
              <div
                className="w-12 h-12 flex items-center justify-center cursor-pointer text-foreground-muted hover:text-foreground transition-colors duration-200"
                onClick={() => setIsExpanded(true)}
              >
                <ChevronRight size={24} />
              </div>
            </Tooltip>
          )}
        </div>

        <Tooltip content={!isExpanded ? t('activity.databaseExplorer') : undefined}>
          <div
            className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'database' ? 'text-foreground border-l-[3px] border-accent' : 'text-foreground-muted hover:text-foreground hover:bg-border-default border-l-[3px] border-transparent'}`}
            onClick={() => {
              setActiveActivity('database');
              setIsSidebarOpen(true);
            }}
          >
            <Database size={24} className={isExpanded ? 'mr-3 flex-shrink-0' : ''} />
            {isExpanded && <span className="text-[13px] truncate">{t('activity.databaseExplorer')}</span>}
          </div>
        </Tooltip>

        {/* 指标入口临时隐藏，MetricsExplorer 代码保留，后续可恢复 */}
        {false && (
          <Tooltip content={!isExpanded ? t('activity.metrics') : undefined}>
            <div
              className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'metrics' ? 'text-foreground border-l-[3px] border-accent' : 'text-foreground-muted hover:text-foreground hover:bg-border-default border-l-[3px] border-transparent'}`}
              onClick={() => {
                setActiveActivity('metrics');
                setIsSidebarOpen(true);
              }}
            >
              <Activity size={24} className={isExpanded ? 'mr-3 flex-shrink-0' : ''} />
              {isExpanded && <span className="text-[13px] truncate">{t('activity.metrics')}</span>}
            </div>
          </Tooltip>
        )}

        <Tooltip content={!isExpanded ? t('activity.knowledgeGraph') : undefined}>
          <div
            className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'graph' ? 'text-foreground border-l-[3px] border-accent' : 'text-foreground-muted hover:text-foreground hover:bg-border-default border-l-[3px] border-transparent'}`}
            onClick={() => {
              setActiveActivity('graph');
              setIsSidebarOpen(true);
            }}
          >
            <Network size={24} className={isExpanded ? 'mr-3 flex-shrink-0' : ''} />
            {isExpanded && <span className="text-[13px] truncate">{t('activity.knowledgeGraph')}</span>}
          </div>
        </Tooltip>

        <Tooltip content={!isExpanded ? t('activity.erDesigner') : undefined}>
          <div
            className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'er_designer' ? 'text-foreground border-l-[3px] border-accent' : 'text-foreground-muted hover:text-foreground hover:bg-border-default border-l-[3px] border-transparent'}`}
            onClick={() => {
              setActiveActivity('er_designer');
              setIsSidebarOpen(true);
            }}
          >
            <Grid3x3 size={24} className={isExpanded ? 'mr-3 flex-shrink-0' : ''} />
            {isExpanded && <span className="text-[13px] truncate">{t('activity.erDesigner')}</span>}
          </div>
        </Tooltip>

        <Tooltip content={!isExpanded ? t('migration.title') : undefined}>
          <div
            className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'migration' ? 'text-foreground border-l-[3px] border-accent' : 'text-foreground-muted hover:text-foreground hover:bg-border-default border-l-[3px] border-transparent'}`}
            onClick={() => {
              setActiveActivity('migration');
              setIsSidebarOpen(true);
            }}
          >
            <ArrowLeftRight size={24} className={isExpanded ? 'mr-3 flex-shrink-0' : ''} />
            {isExpanded && <span className="text-[13px] truncate">{t('migration.title')}</span>}
          </div>
        </Tooltip>

        <Tooltip content={!isExpanded ? t('activity.myTasks') : undefined}>
          <div
            className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'tasks' ? 'text-foreground border-l-[3px] border-accent' : 'text-foreground-muted hover:text-foreground hover:bg-border-default border-l-[3px] border-transparent'}`}
            onClick={() => {
              setActiveActivity('tasks');
              setIsSidebarOpen(true);
            }}
          >
            <ListTodo size={24} className={isExpanded ? 'mr-3 flex-shrink-0' : ''} />
            {isExpanded && <span className="text-[13px] truncate">{t('activity.myTasks')}</span>}
          </div>
        </Tooltip>
      </div>

      <div className="flex flex-col w-full">
        <Tooltip content={!isExpanded ? t('activity.settings') : undefined}>
          <div
            className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'settings' ? 'text-foreground border-l-[3px] border-accent' : 'text-foreground-muted hover:text-foreground hover:bg-border-default border-l-[3px] border-transparent'}`}
            onClick={() => { setActiveActivity('settings'); setIsSidebarOpen(true); }}
          >
            <Settings size={24} className={`transition-transform duration-300 hover:rotate-90 ${isExpanded ? 'mr-3 flex-shrink-0' : ''}`} />
            {isExpanded && <span className="text-[13px] truncate">{t('activity.settings')}</span>}
          </div>
        </Tooltip>
      </div>
    </div>
  );
};
