import React, { useEffect, useState } from 'react';
import { Plus, MoreHorizontal, RefreshCw, Search, X, Filter, DatabaseZap, TableProperties, LayoutDashboard } from 'lucide-react';
import { TreeItem } from './TreeItem';
import { useConnectionStore } from '../../store';
import { ConnectionModal } from '../ConnectionModal';
import { LlmSettingsPanel } from '../Settings/LlmSettings';

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
  const { connections, activeConnectionId, tables, loadConnections, setActiveConnection, loadTables, deleteConnection } = useConnectionStore();
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    loadConnections();
  }, []);

  const handleConnectionClick = (id: number) => {
    setActiveConnection(id);
    loadTables(id);
    toggleFolder(`conn_${id}`);
  };

  const handleRefresh = async () => {
    await loadConnections();
    if (activeConnectionId) await loadTables(activeConnectionId);
    showToast('已刷新连接列表');
  };

  if (!isSidebarOpen) return null;

  return (
    <>
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
                <Plus size={16} className="cursor-pointer hover:text-[#d4d4d4]" onClick={() => setShowModal(true)} />
                <RefreshCw size={16} className="cursor-pointer hover:text-[#d4d4d4]" onClick={handleRefresh} />
              </div>
            </div>
            <div className="p-2 border-b border-[#2b2b2b]">
              <div className="flex items-center bg-[#252526] border border-[#3c3c3c] rounded px-2 py-1 focus-within:border-[#007acc] transition-colors">
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
              </div>
            </div>
            <div className="flex-1 overflow-y-auto py-2">
              {connections.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-[#858585]">
                  <DatabaseZap size={24} className="mx-auto mb-2 opacity-30" />
                  <p>暂无连接</p>
                  <p className="mt-1 text-[#3794ff] cursor-pointer hover:underline" onClick={() => setShowModal(true)}>+ 新建连接</p>
                </div>
              ) : (
                connections
                  .filter(c => !searchQuery || c.name.toLowerCase().includes(searchQuery.toLowerCase()))
                  .map(conn => (
                    <div key={conn.id}>
                      <TreeItem
                        label={conn.name}
                        id={`conn_${conn.id}`}
                        icon={DatabaseZap}
                        hasChildren
                        isOpen={expandedFolders[`conn_${conn.id}`]}
                        active={activeConnectionId === conn.id}
                        onClick={() => handleConnectionClick(conn.id)}
                      />
                      {expandedFolders[`conn_${conn.id}`] && activeConnectionId === conn.id && (
                        tables.length === 0 ? (
                          <div className="px-3 py-1 text-xs text-[#858585]" style={{ paddingLeft: '2rem' }}>暂无表</div>
                        ) : (
                          tables.map(t => (
                            <TreeItem
                              key={t.name}
                              label={t.name}
                              icon={TableProperties}
                              indent={1}
                              onClick={() => onTableClick(t.name, conn.name)}
                            />
                          ))
                        )
                      )}
                    </div>
                  ))
              )}
            </div>
          </>
        ) : activeActivity === 'settings' ? (
          <>
            <div className="h-10 flex items-center px-3 border-b border-[#2b2b2b]">
              <span className="font-medium text-[#d4d4d4]">设置</span>
            </div>
            <LlmSettingsPanel />
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

      {showModal && <ConnectionModal onClose={() => { setShowModal(false); loadConnections(); }} />}
    </>
  );
};
