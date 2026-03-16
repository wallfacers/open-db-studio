import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { User, Database, ListTodo, BarChart2, Network, ArrowLeftRight, Settings, ChevronRight, ChevronLeft } from 'lucide-react';
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
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className={`flex flex-col py-2 border-r border-[#1e2d42] bg-[#0d1117] justify-between flex-shrink-0 z-20 transition-all duration-300 ${isExpanded ? 'w-48' : 'w-14'}`}>
      <div className="flex flex-col w-full">
        <div className={`flex items-center justify-between transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} hover:bg-[#1e2d42] border-l-[3px] border-transparent`}>
          {isExpanded ? (
            <>
              <div
                className="flex items-center cursor-pointer overflow-hidden flex-1"
                onClick={() => showToast(t('activity.openUserProfile'), 'info')}
              >
                <div className="w-6 h-6 rounded-full bg-[#00c9a7] flex items-center justify-center text-white mr-3 flex-shrink-0">
                  <User size={14} />
                </div>
                <span className="text-[#c8daea] text-[13px] truncate">{t('activity.userProfile')}</span>
              </div>
              <Tooltip content={t('activity.collapse')}>
                <div
                  className="flex items-center justify-center cursor-pointer text-[#7a9bb8] hover:text-white"
                  onClick={() => setIsExpanded(false)}
                >
                  <ChevronLeft size={20} />
                </div>
              </Tooltip>
            </>
          ) : (
            <Tooltip content={t('activity.expand')}>
              <div
                className="w-12 h-12 flex items-center justify-center cursor-pointer text-[#7a9bb8] hover:text-white"
                onClick={() => setIsExpanded(true)}
              >
                <ChevronRight size={24} />
              </div>
            </Tooltip>
          )}
        </div>

        <Tooltip content={!isExpanded ? t('activity.databaseExplorer') : undefined}>
          <div
            className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'database' ? 'text-[#e8f4ff] border-l-[3px] border-[#00c9a7]' : 'text-[#7a9bb8] hover:text-[#e8f4ff] hover:bg-[#1e2d42] border-l-[3px] border-transparent'}`}
            onClick={() => {
              setActiveActivity('database');
              setIsSidebarOpen(true);
            }}
          >
            <Database size={24} className={isExpanded ? 'mr-3 flex-shrink-0' : ''} />
            {isExpanded && <span className="text-[13px] truncate">{t('activity.databaseExplorer')}</span>}
          </div>
        </Tooltip>

        <Tooltip content={!isExpanded ? '业务指标' : undefined}>
          <div
            className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'metrics' ? 'text-[#e8f4ff] border-l-[3px] border-[#00c9a7]' : 'text-[#7a9bb8] hover:text-[#e8f4ff] hover:bg-[#1e2d42] border-l-[3px] border-transparent'}`}
            onClick={() => {
              setActiveActivity('metrics');
              setIsSidebarOpen(true);
            }}
          >
            <BarChart2 size={24} className={isExpanded ? 'mr-3 flex-shrink-0' : ''} />
            {isExpanded && <span className="text-[13px] truncate">业务指标</span>}
          </div>
        </Tooltip>

        <Tooltip content={!isExpanded ? '知识图谱' : undefined}>
          <div
            className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'graph' ? 'text-[#e8f4ff] border-l-[3px] border-[#00c9a7]' : 'text-[#7a9bb8] hover:text-[#e8f4ff] hover:bg-[#1e2d42] border-l-[3px] border-transparent'}`}
            onClick={() => {
              setActiveActivity('graph');
              setIsSidebarOpen(true);
            }}
          >
            <Network size={24} className={isExpanded ? 'mr-3 flex-shrink-0' : ''} />
            {isExpanded && <span className="text-[13px] truncate">知识图谱</span>}
          </div>
        </Tooltip>

        <Tooltip content={!isExpanded ? '数据迁移' : undefined}>
          <div
            className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'migration' ? 'text-[#e8f4ff] border-l-[3px] border-[#00c9a7]' : 'text-[#7a9bb8] hover:text-[#e8f4ff] hover:bg-[#1e2d42] border-l-[3px] border-transparent'}`}
            onClick={() => {
              setActiveActivity('migration');
              setIsSidebarOpen(true);
            }}
          >
            <ArrowLeftRight size={24} className={isExpanded ? 'mr-3 flex-shrink-0' : ''} />
            {isExpanded && <span className="text-[13px] truncate">数据迁移</span>}
          </div>
        </Tooltip>

        <Tooltip content={!isExpanded ? t('activity.myTasks') : undefined}>
          <div
            className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'tasks' ? 'text-[#e8f4ff] border-l-[3px] border-[#00c9a7]' : 'text-[#7a9bb8] hover:text-[#e8f4ff] hover:bg-[#1e2d42] border-l-[3px] border-transparent'}`}
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
            className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'settings' ? 'text-[#e8f4ff] border-l-[3px] border-[#00c9a7]' : 'text-[#7a9bb8] hover:text-[#e8f4ff] hover:bg-[#1e2d42] border-l-[3px] border-transparent'}`}
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
