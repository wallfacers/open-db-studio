import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, MoreHorizontal, RefreshCw, Search, X, Filter, DatabaseZap, TableProperties, LayoutDashboard, FilePlus, PlugZap, Unplug, Pencil, Trash2 } from 'lucide-react';
import { TreeItem } from './TreeItem';
import { useConnectionStore } from '../../store';
import { ConnectionModal } from '../ConnectionModal';

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
  onNewQuery: (connId: number, connName: string) => void;
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
  onTableClick,
  onNewQuery
}) => {
  const { t } = useTranslation();
  const { connections, activeConnectionId, tables, loadConnections, setActiveConnection, loadTables, deleteConnection, disconnectConnection } = useConnectionStore();
  const [showModal, setShowModal] = useState(false);
  const [connContextMenu, setConnContextMenu] = useState<{ connId: number; x: number; y: number } | null>(null);
  const connMenuRef = useRef<HTMLDivElement>(null);
  const [editingConn, setEditingConn] = useState<import('../../types').Connection | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  useEffect(() => {
    loadConnections();
  }, []);

  // 单击：仅选中（展开/折叠文件夹），不加载数据
  const handleConnectionSelect = (id: number) => {
    setActiveConnection(id);
    toggleFolder(`conn_${id}`);
  };

  // 双击：连接并加载表
  const handleConnectionOpen = (id: number) => {
    setActiveConnection(id);
    loadTables(id);
    if (!expandedFolders[`conn_${id}`]) toggleFolder(`conn_${id}`);
  };

  const handleRefresh = async () => {
    await loadConnections();
    if (activeConnectionId) await loadTables(activeConnectionId);
    showToast(t('explorer.connectionListRefreshed'));
  };

  const handleDeleteConnection = async (id: number) => {
    if (!window.confirm(t('explorer.confirmDeleteConnection'))) return;
    await deleteConnection(id);
    showToast(t('explorer.connectionDeleted'));
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (connMenuRef.current && !connMenuRef.current.contains(e.target as Node)) {
        setConnContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (!isSidebarOpen) return null;

  return (
    <>
      <div className="flex flex-col border-r border-[#1e2d42] bg-[#0d1117] flex-shrink-0 relative" style={{ width: sidebarWidth }}>
        <div
          className="absolute right-[-2px] top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#00c9a7] z-10 transition-colors"
          onMouseDown={handleSidebarResize}
        ></div>

        {activeActivity === 'database' ? (
          <>
            <div className="h-10 flex items-center justify-between px-3 border-b border-[#1e2d42]">
              <span className="font-medium text-[#c8daea]">{t('explorer.database')}</span>
              <div className="flex items-center space-x-2 text-[#7a9bb8]">
                <Plus size={16} className="cursor-pointer hover:text-[#c8daea]" onClick={() => setShowModal(true)} />
                <RefreshCw size={16} className="cursor-pointer hover:text-[#c8daea]" onClick={handleRefresh} />
              </div>
            </div>
            <div className="p-2 border-b border-[#1e2d42]">
              <div className="flex items-center bg-[#151d28] border border-[#2a3f5a] rounded px-2 py-1 focus-within:border-[#00a98f] transition-colors">
                <Search size={14} className="text-[#7a9bb8] mr-1" />
                <input
                  type="text"
                  placeholder={t('explorer.searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="bg-transparent border-none outline-none text-[#c8daea] w-full text-xs placeholder-[#7a9bb8]"
                />
                {searchQuery && (
                  <X size={14} className="text-[#7a9bb8] ml-1 cursor-pointer hover:text-[#c8daea]" onClick={() => setSearchQuery('')} />
                )}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto py-2">
              {connections.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-[#7a9bb8]">
                  <DatabaseZap size={24} className="mx-auto mb-2 opacity-30" />
                  <p>{t('explorer.noConnections')}</p>
                  <p className="mt-1 text-[#00c9a7] cursor-pointer hover:underline" onClick={() => setShowModal(true)}>{t('explorer.newConnection')}</p>
                </div>
              ) : (
                connections
                  .filter(c => !searchQuery || c.name.toLowerCase().includes(searchQuery.toLowerCase()))
                  .map(conn => (
                    <div
                      key={conn.id}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setConnContextMenu({ connId: conn.id, x: e.clientX, y: e.clientY });
                      }}
                    >
                      <TreeItem
                        label={conn.name}
                        id={`conn_${conn.id}`}
                        icon={DatabaseZap}
                        hasChildren
                        isOpen={expandedFolders[`conn_${conn.id}`]}
                        active={activeConnectionId === conn.id}
                        onClick={() => handleConnectionSelect(conn.id)}
                        onDoubleClick={() => handleConnectionOpen(conn.id)}
                      />
                      {expandedFolders[`conn_${conn.id}`] && activeConnectionId === conn.id && (
                        tables.length === 0 ? (
                          <div className="px-3 py-1 text-xs text-[#7a9bb8]" style={{ paddingLeft: '2rem' }}>{t('explorer.noTables')}</div>
                        ) : (
                          tables.map(t => (
                            <TreeItem
                              key={t.name}
                              label={t.name}
                              icon={TableProperties}
                              indent={1}
                              active={selectedTable === t.name}
                              onClick={() => setSelectedTable(t.name)}
                              onDoubleClick={() => { setSelectedTable(t.name); onTableClick(t.name, conn.name); }}
                            />
                          ))
                        )
                      )}
                    </div>
                  ))
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-[#7a9bb8]">
            <div className="text-center">
              <LayoutDashboard size={48} className="mx-auto mb-4 opacity-20" />
              <p>{t('explorer.databaseOverview')}</p>
            </div>
          </div>
        )}
      </div>

      {connContextMenu && (
        <div
          ref={connMenuRef}
          className="fixed z-50 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg py-1 min-w-[140px]"
          style={{ left: connContextMenu.x, top: connContextMenu.y }}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed enabled:text-[#c8daea] enabled:hover:bg-[#003d2f] enabled:hover:text-white"
            disabled={activeConnectionId === connContextMenu.connId}
            onClick={() => {
              const conn = connections.find(c => c.id === connContextMenu.connId);
              if (conn) handleConnectionOpen(conn.id);
              setConnContextMenu(null);
            }}
          >
            <PlugZap size={13} />
            打开连接
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed enabled:text-[#c8daea] enabled:hover:bg-[#003d2f] enabled:hover:text-white"
            disabled={activeConnectionId !== connContextMenu.connId}
            onClick={() => {
              disconnectConnection(connContextMenu.connId);
              setConnContextMenu(null);
            }}
          >
            <Unplug size={13} />
            关闭连接
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#003d2f] hover:text-white flex items-center gap-2"
            onClick={() => {
              const conn = connections.find(c => c.id === connContextMenu.connId);
              if (conn) onNewQuery(conn.id, conn.name);
              setConnContextMenu(null);
            }}
          >
            <FilePlus size={13} />
            新建查询
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-[#c8daea] hover:bg-[#003d2f] hover:text-white flex items-center gap-2"
            onClick={() => {
              const conn = connections.find(c => c.id === connContextMenu.connId);
              if (conn) setEditingConn(conn);
              setConnContextMenu(null);
            }}
          >
            <Pencil size={13} />
            {t('explorer.edit')}
          </button>
          <div className="h-px bg-[#2a3f5a] my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-[#003d2f] hover:text-red-300 flex items-center gap-2"
            onClick={() => {
              handleDeleteConnection(connContextMenu.connId);
              setConnContextMenu(null);
            }}
          >
            <Trash2 size={13} />
            {t('explorer.delete')}
          </button>
        </div>
      )}

      {editingConn && (
        <ConnectionModal
          connection={editingConn}
          onClose={() => { setEditingConn(null); loadConnections(); }}
        />
      )}

      {showModal && <ConnectionModal onClose={() => { setShowModal(false); loadConnections(); }} />}
    </>
  );
};
