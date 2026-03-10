import React from 'react';
import { Plus, MoreHorizontal, RefreshCw, Search, X, Filter, Folder, DatabaseZap, TableProperties, LayoutDashboard } from 'lucide-react';
import { TreeItem } from './TreeItem';

interface ExplorerProps {
  isSidebarOpen: boolean;
  sidebarWidth: number;
  handleSidebarResize: (e: React.MouseEvent) => void;
  showToast: (msg: string) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  expandedFolders: Record<string, boolean>;
  toggleFolder: (folder: string) => void;
  activeActivity: string;
  onTableClick: (tableName: string, dbName?: string) => void;
}

export const Explorer: React.FC<ExplorerProps> = ({
  isSidebarOpen,
  sidebarWidth,
  handleSidebarResize,
  showToast,
  searchQuery,
  setSearchQuery,
  expandedFolders,
  toggleFolder,
  activeActivity,
  onTableClick
}) => {
  if (!isSidebarOpen) return null;

  return (
    <div className="flex flex-col border-r border-[#2b2b2b] bg-[#181818] flex-shrink-0 relative" style={{ width: sidebarWidth }}>
      <div 
        className="absolute right-[-2px] top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#3794ff] z-10 transition-colors"
        onMouseDown={handleSidebarResize}
      ></div>
      
      {activeActivity === 'database' ? (
        <>
          <div className="h-10 flex items-center justify-between px-3 border-b border-[#2b2b2b]">
            <span className="font-medium text-[#d4d4d4]">数据库</span>
            <div className="flex items-center space-x-2 text-[#858585]">
              <Plus size={16} className="cursor-pointer hover:text-[#d4d4d4]" title="New Connection" onClick={() => showToast('打开新建连接窗口')} />
              <MoreHorizontal size={16} className="cursor-pointer hover:text-[#d4d4d4]" title="More Actions" onClick={() => showToast('打开更多操作菜单')} />
            </div>
          </div>
          <div className="p-2 border-b border-[#2b2b2b]">
            <div className="flex items-center bg-[#252526] border border-[#3c3c3c] rounded px-2 py-1 focus-within:border-[#007acc] transition-colors">
              <Plus size={14} className="text-[#858585] mr-1 cursor-pointer hover:text-[#d4d4d4]" title="Add" onClick={() => showToast('添加过滤条件')} />
              <RefreshCw size={14} className="text-[#858585] mr-1 cursor-pointer hover:text-[#d4d4d4]" title="Refresh" onClick={() => showToast('刷新目录树')} />
              <div className="w-[1px] h-3 bg-[#3c3c3c] mx-1"></div>
              <Search size={14} className="text-[#858585] mr-1" />
              <input 
                type="text" 
                placeholder="搜索" 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-transparent border-none outline-none text-[#d4d4d4] w-full text-xs placeholder-[#858585]"
              />
              {searchQuery && (
                <X size={14} className="text-[#858585] ml-1 cursor-pointer hover:text-[#d4d4d4]" onClick={() => setSearchQuery('')} />
              )}
              <Filter size={14} className={`ml-1 cursor-pointer ${searchQuery ? 'text-[#3794ff]' : 'text-[#858585] hover:text-[#d4d4d4]'}`} title="Filter" onClick={() => showToast('打开高级过滤')} />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto py-2">
            <TreeItem label="New Group" id="New Group" icon={Folder} hasChildren isOpen={expandedFolders['New Group']} onClick={toggleFolder} />
            <TreeItem label="Demo data" id="Demo data" icon={Folder} hasChildren isOpen={expandedFolders['Demo data']} onClick={toggleFolder} />
            <TreeItem label="MySQL_demo" id="MySQL_demo" icon={DatabaseZap} hasChildren isOpen={expandedFolders['MySQL_demo']} onClick={toggleFolder} />
            <TreeItem label="SQLServer" id="SQLServer" icon={DatabaseZap} hasChildren isOpen={expandedFolders['SQLServer']} onClick={toggleFolder} />
            <TreeItem label="PostgreSql_demo" id="PostgreSql_demo" icon={DatabaseZap} hasChildren isOpen={expandedFolders['PostgreSql_demo']} onClick={toggleFolder} />
            <TreeItem label="user" id="user" icon={Folder} hasChildren isOpen={expandedFolders['user']} onClick={toggleFolder} />
            <TreeItem label="local" id="local" icon={Folder} hasChildren isOpen={expandedFolders['local']} onClick={toggleFolder} />
            <TreeItem label="demo" id="demo" secondaryLabel="7 of 7" icon={DatabaseZap} hasChildren isOpen={expandedFolders['demo']} onClick={toggleFolder} />
            
            {expandedFolders['demo'] && (
              <>
                <TreeItem label="ERP" id="ERP" icon={Folder} hasChildren indent={1} isOpen={expandedFolders['ERP']} onClick={toggleFolder} />
                <TreeItem label="birth_analysis" id="birth_analysis" icon={Folder} hasChildren isOpen={expandedFolders['birth_analysis']} indent={1} onClick={toggleFolder} />
                
                {expandedFolders['birth_analysis'] && (
                  <>
                    <TreeItem label="表" id="表" icon={Folder} hasChildren isOpen={expandedFolders['表']} indent={2} onClick={toggleFolder} />
                    
                    {expandedFolders['表'] && (
                      <>
                        <TreeItem label="birth_record 出生人口..." icon={TableProperties} indent={3} onClick={() => onTableClick('birth_record', 'MySQL_demo')} />
                        <TreeItem label="birth_trend_analysis" icon={TableProperties} indent={3} active onClick={() => onTableClick('birth_trend_analysis', 'MySQL_demo')} />
                        <TreeItem label="newborn_disease 新..." icon={TableProperties} indent={3} onClick={() => onTableClick('newborn_disease', 'MySQL_demo')} />
                        <TreeItem label="parent_info 父母信息" icon={TableProperties} indent={3} onClick={() => onTableClick('parent_info', 'MySQL_demo')} />
                        <TreeItem label="policy_impact 政策影..." icon={TableProperties} indent={3} onClick={() => onTableClick('policy_impact', 'MySQL_demo')} />
                        <TreeItem label="population_statistics" icon={TableProperties} indent={3} onClick={() => onTableClick('population_statistics', 'MySQL_demo')} />
                        <TreeItem label="prenatal_care 产前检..." icon={TableProperties} indent={3} onClick={() => onTableClick('prenatal_care', 'MySQL_demo')} />
                        <TreeItem label="region 地区信息表" icon={TableProperties} indent={3} onClick={() => onTableClick('region', 'MySQL_demo')} />
                        <TreeItem label="socioeconomic_facto..." icon={TableProperties} indent={3} onClick={() => onTableClick('socioeconomic_facto', 'MySQL_demo')} />
                      </>
                    )}
                    
                    <TreeItem label="视图" id="视图" icon={Folder} hasChildren indent={2} isOpen={expandedFolders['视图']} onClick={toggleFolder} />
                    <TreeItem label="函数" id="函数" icon={Folder} hasChildren indent={2} isOpen={expandedFolders['函数']} onClick={toggleFolder} />
                    <TreeItem label="存储过程" id="存储过程" icon={Folder} hasChildren indent={2} isOpen={expandedFolders['存储过程']} onClick={toggleFolder} />
                  </>
                )}
              </>
            )}
          </div>
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center text-[#858585]">
          <div className="text-center">
            <LayoutDashboard size={48} className="mx-auto mb-4 opacity-20" />
            <p>数据库总览信息</p>
          </div>
        </div>
      )}
    </div>
  );
};
