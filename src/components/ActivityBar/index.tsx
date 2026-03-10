import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { User, Database, LayoutDashboard, MessageSquare, LayoutGrid, RefreshCw, Bell, Settings, ChevronRight, ChevronLeft } from 'lucide-react';

interface ActivityBarProps {
  activeActivity: string;
  setActiveActivity: (activity: string) => void;
  isSidebarOpen: boolean;
  setIsSidebarOpen: (isOpen: boolean) => void;
  isAssistantOpen: boolean;
  setIsAssistantOpen: (isOpen: boolean) => void;
  showToast: (msg: string) => void;
}

export const ActivityBar: React.FC<ActivityBarProps> = ({
  activeActivity,
  setActiveActivity,
  isSidebarOpen,
  setIsSidebarOpen,
  isAssistantOpen,
  setIsAssistantOpen,
  showToast
}) => {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className={`flex flex-col py-2 border-r border-[#2b2b2b] bg-[#181818] justify-between flex-shrink-0 z-20 transition-all duration-300 ${isExpanded ? 'w-48' : 'w-14'}`}>
      <div className="flex flex-col w-full">
        <div className={`flex items-center justify-between transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} hover:bg-[#2b2b2b] border-l-[3px] border-transparent`}>
          {isExpanded ? (
            <>
              <div 
                className="flex items-center cursor-pointer overflow-hidden flex-1"
                title={t('activity.userProfile')} 
                onClick={() => showToast(t('activity.openUserProfile'))}
              >
                <div className="w-6 h-6 rounded-full bg-[#3794ff] flex items-center justify-center text-white mr-3 flex-shrink-0">
                  <User size={14} />
                </div>
                <span className="text-[#d4d4d4] text-[13px] truncate">{t('activity.userProfile')}</span>
              </div>
              <div 
                className="flex items-center justify-center cursor-pointer text-[#858585] hover:text-white"
                title={t('activity.collapse')}
                onClick={() => setIsExpanded(false)}
              >
                <ChevronLeft size={20} />
              </div>
            </>
          ) : (
            <div 
              className="w-12 h-12 flex items-center justify-center cursor-pointer text-[#858585] hover:text-white"
              title={t('activity.expand')}
              onClick={() => setIsExpanded(true)}
            >
              <ChevronRight size={24} />
            </div>
          )}
        </div>
        
        <div 
          className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'database' ? 'text-[#ffffff] border-l-[3px] border-[#3794ff]' : 'text-[#858585] hover:text-[#ffffff] hover:bg-[#2b2b2b] border-l-[3px] border-transparent'}`}
          onClick={() => {
            setActiveActivity('database');
            setIsSidebarOpen(true);
          }}
          title={t('activity.databaseExplorer')}
        >
          <Database size={24} className={isExpanded ? 'mr-3 flex-shrink-0' : ''} />
          {isExpanded && <span className="text-[13px] truncate">{t('activity.databaseExplorer')}</span>}
        </div>
        
        <div 
          className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'dashboard' ? 'text-[#ffffff] border-l-[3px] border-[#3794ff]' : 'text-[#858585] hover:text-[#ffffff] hover:bg-[#2b2b2b] border-l-[3px] border-transparent'}`}
          onClick={() => {
            setActiveActivity('dashboard');
            setIsSidebarOpen(true);
          }}
          title={t('activity.dashboard')}
        >
          <LayoutDashboard size={24} className={isExpanded ? 'mr-3 flex-shrink-0' : ''} />
          {isExpanded && <span className="text-[13px] truncate">{t('activity.dashboard')}</span>}
        </div>
        
        <div 
          className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'chat' ? 'text-[#ffffff] border-l-[3px] border-[#3794ff]' : 'text-[#858585] hover:text-[#ffffff] hover:bg-[#2b2b2b] border-l-[3px] border-transparent'}`}
          onClick={() => {
            setActiveActivity('chat');
            setIsAssistantOpen(true);
          }}
          title={t('activity.aiAssistant')}
        >
          <MessageSquare size={24} className={isExpanded ? 'mr-3 flex-shrink-0' : ''} />
          {isExpanded && <span className="text-[13px] truncate">{t('activity.aiAssistant')}</span>}
        </div>
        
        <div 
          className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'grid' ? 'text-[#ffffff] border-l-[3px] border-[#3794ff]' : 'text-[#858585] hover:text-[#ffffff] hover:bg-[#2b2b2b] border-l-[3px] border-transparent'}`}
          onClick={() => setActiveActivity('grid')}
          title={t('activity.gridView')}
        >
          <LayoutGrid size={24} className={isExpanded ? 'mr-3 flex-shrink-0' : ''} />
          {isExpanded && <span className="text-[13px] truncate">{t('activity.gridView')}</span>}
        </div>
      </div>
      
      <div className="flex flex-col w-full">
        <div 
          className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} text-[#858585] hover:text-[#ffffff] hover:bg-[#2b2b2b] border-l-[3px] border-transparent`}
          onClick={() => {
            const el = document.getElementById('refresh-icon');
            if (el) {
              el.classList.add('animate-spin');
              setTimeout(() => el.classList.remove('animate-spin'), 1000);
            }
          }}
          title={t('activity.refresh')}
        >
          <RefreshCw id="refresh-icon" size={24} className={isExpanded ? 'mr-3 flex-shrink-0' : ''} />
          {isExpanded && <span className="text-[13px] truncate">{t('activity.refresh')}</span>}
        </div>
        
        <div 
          className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} text-[#858585] hover:text-[#ffffff] hover:bg-[#2b2b2b] border-l-[3px] border-transparent`}
          title={t('activity.notifications')} 
          onClick={() => showToast(t('activity.openNotifications'))}
        >
          <div className="relative">
            <Bell size={24} className={isExpanded ? 'mr-3 flex-shrink-0' : ''} />
            <span className={`absolute bg-[#3794ff] ${isExpanded ? 'top-0 right-3 w-2 h-2' : 'top-0 right-0 w-2 h-2'}`}></span>
          </div>
          {isExpanded && <span className="text-[13px] truncate">{t('activity.notifications')}</span>}
        </div>
        
        <div
          className={`flex items-center cursor-pointer transition-colors ${isExpanded ? 'w-full px-4 h-12' : 'w-12 h-12 mx-auto justify-center'} ${activeActivity === 'settings' ? 'text-[#ffffff] border-l-[3px] border-[#3794ff]' : 'text-[#858585] hover:text-[#ffffff] hover:bg-[#2b2b2b] border-l-[3px] border-transparent'}`}
          title={t('activity.settings')}
          onClick={() => { setActiveActivity('settings'); setIsSidebarOpen(true); }}
        >
          <Settings size={24} className={`transition-transform duration-300 hover:rotate-90 ${isExpanded ? 'mr-3 flex-shrink-0' : ''}`} />
          {isExpanded && <span className="text-[13px] truncate">{t('activity.settings')}</span>}
        </div>
      </div>
    </div>
  );
};
