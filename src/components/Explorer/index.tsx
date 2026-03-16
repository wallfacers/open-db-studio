import React, { useEffect, useState } from 'react';
import { Plus, RefreshCw, Search, X, DatabaseZap, FolderPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTreeStore } from '../../store/treeStore';
import { useConnectionStore, loadOpenedConnectionIds } from '../../store/connectionStore';
import { DBTree } from './DBTree';
import { ConnectionModal } from '../ConnectionModal';
import { GroupModal } from '../GroupModal';
import { Tooltip } from '../common/Tooltip';
import { invoke } from '@tauri-apps/api/core';
import i18n from '../../i18n';
import type { ToastLevel } from '../Toast';

interface ExplorerProps {
  isSidebarOpen: boolean;
  sidebarWidth: number;
  handleSidebarResize: (e: React.MouseEvent) => void;
  showToast: (msg: string, level?: ToastLevel) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  activeActivity: string;
  onNewQuery: (connectionId: number, connName: string, database?: string, schema?: string) => void;
  onOpenTableData: (tableName: string, connectionId: number, database?: string, schema?: string) => void;
  onOpenTableStructure: (connectionId: number, database?: string, schema?: string, tableName?: string) => void;
}

export const Explorer: React.FC<ExplorerProps> = ({
  isSidebarOpen,
  sidebarWidth,
  handleSidebarResize,
  showToast,
  searchQuery,
  setSearchQuery,
  activeActivity,
  onNewQuery,
  onOpenTableData,
  onOpenTableStructure,
}) => {
  const { t } = useTranslation();
  const { init, nodes } = useTreeStore();
  const { activeConnectionIds, openConnection, closeConnection } = useConnectionStore();
  const [showModal, setShowModal] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);

  useEffect(() => {
    const restoreOpenedConnections = async () => {
      // 仅首次挂载时初始化；若 store 已有数据（从设置页切回）则跳过，
      // 避免 init() 内的 expandedIds: new Set() 清空已展开节点状态
      if (useTreeStore.getState().nodes.size === 0) {
        await init();
      }
      // 静默恢复上次已打开的连接，失败则跳过（不弹 toast）
      const savedIds = loadOpenedConnectionIds();
      if (savedIds.length > 0) {
        await Promise.allSettled(savedIds.map(id => handleOpenConnectionSilent(id)));
      }
    };
    restoreOpenedConnections();
  }, []);

  // 静默版本：恢复上次展开状态时使用，失败不弹 toast
  const handleOpenConnectionSilent = async (connectionId: number) => {
    const nodeId = `conn_${connectionId}`;
    const store = useTreeStore.getState();
    // 验证节点存在（连接可能已被删除）
    if (!store.nodes.get(nodeId)) return;
    if (!store.nodes.get(nodeId)?.loaded) {
      await store.loadChildren(nodeId);
      if (!useTreeStore.getState().nodes.get(nodeId)?.loaded) return;
    }
    openConnection(connectionId);
    const conn = useConnectionStore.getState().connections.find((c) => c.id === connectionId);
    if (conn) {
      invoke<string>('get_db_version', { connectionId })
        .then((version) => {
          if (version) {
            useConnectionStore.getState().setMeta(connectionId, {
              dbVersion: version,
              driver: conn.driver,
              host: conn.host ?? '',
              port: conn.port ?? undefined,
              name: conn.name,
            });
          }
        })
        .catch(() => {});
    }
    const { expandedIds, toggleExpand } = useTreeStore.getState();
    if (!expandedIds.has(nodeId)) toggleExpand(nodeId);
  };

  const handleOpenConnection = async (connectionId: number) => {
    const nodeId = `conn_${connectionId}`;
    const store = useTreeStore.getState();

    // 若子节点未加载，先加载以验证连接是否可用
    if (!store.nodes.get(nodeId)?.loaded) {
      await store.loadChildren(nodeId);
      const after = useTreeStore.getState();
      if (!after.nodes.get(nodeId)?.loaded) {
        // 加载失败：读取错误信息并提示，不标记为已连接
        const errMsg = after.error ?? i18n.t('dbTree.connectionFailed');
        showToast(errMsg, 'error');
        return;
      }
    }

    // 连接成功：标记为已连接并展开
    openConnection(connectionId);

    // 连接成功后异步缓存 DB 版本（失败静默，不影响主流程）
    const conn = useConnectionStore.getState().connections.find((c) => c.id === connectionId);
    if (conn) {
      invoke<string>('get_db_version', { connectionId })
        .then((version) => {
          if (version) {
            useConnectionStore.getState().setMeta(connectionId, {
              dbVersion: version,
              driver: conn.driver,
              host: conn.host ?? '',
              port: conn.port ?? undefined,
              name: conn.name,
            });
          }
        })
        .catch(() => {});
    }

    const { expandedIds, toggleExpand } = useTreeStore.getState();
    if (!expandedIds.has(nodeId)) toggleExpand(nodeId);
  };

  const handleCloseConnection = (connectionId: number) => {
    closeConnection(connectionId);

    const nodeId = `conn_${connectionId}`;
    const store = useTreeStore.getState();

    // 折叠树节点
    if (store.expandedIds.has(nodeId)) store.toggleExpand(nodeId);

    // 清空该连接下所有子节点缓存，并重置 loaded，下次打开时重新拉取
    store._removeSubtree(nodeId);
    useTreeStore.setState(s => {
      const nodes = new Map(s.nodes);
      const conn = nodes.get(nodeId);
      if (conn) nodes.set(nodeId, { ...conn, loaded: false });
      return { nodes };
    });
  };

  if (!isSidebarOpen) return null;

  return (
    <>
      <div
        className="flex flex-col border-r border-[#1e2d42] bg-[#0d1117] flex-shrink-0 relative"
        style={{ width: sidebarWidth }}
      >
        <div
          className="absolute right-[-2px] top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#00c9a7] z-20 transition-colors"
          onMouseDown={handleSidebarResize}
        />

        {activeActivity === 'database' ? (
          <>
            <div className="h-10 flex items-center justify-between px-3 border-b border-[#1e2d42]">
              <div className="flex items-center gap-2">
                <DatabaseZap size={14} className="text-[#00c9a7]" />
                <span className="font-medium text-[#c8daea]">{t('explorer.database')}</span>
              </div>
              <div className="flex items-center space-x-2 text-[#7a9bb8]">
                <Tooltip content={t('groupModal.createTitle')}>
                  <FolderPlus
                    size={16}
                    className="cursor-pointer hover:text-[#c8daea]"
                    onClick={() => setShowGroupModal(true)}
                  />
                </Tooltip>
                <Tooltip content={t('connectionModal.newConnection')}>
                  <Plus
                    size={16}
                    className="cursor-pointer hover:text-[#c8daea]"
                    onClick={() => setShowModal(true)}
                  />
                </Tooltip>
                <Tooltip content={t('explorer.refresh')}>
                  <RefreshCw
                    size={16}
                    className="cursor-pointer hover:text-[#c8daea]"
                    onClick={() => init()}
                  />
                </Tooltip>
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
                  <Tooltip content={t('explorer.clearSearch')}>
                    <X
                      size={14}
                      className="text-[#7a9bb8] ml-1 cursor-pointer hover:text-[#c8daea]"
                      onClick={() => setSearchQuery('')}
                    />
                  </Tooltip>
                )}
              </div>
            </div>

            {nodes.size === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-[#7a9bb8]">
                <DatabaseZap size={24} className="mx-auto mb-2 opacity-30" />
                <p>{t('explorer.noConnections')}</p>
                <p
                  className="mt-1 text-[#00c9a7] cursor-pointer hover:underline"
                  onClick={() => setShowModal(true)}
                >
                  {t('explorer.newConnection')}
                </p>
              </div>
            ) : (
              <DBTree
                searchQuery={searchQuery}
                showToast={showToast}
                onNewQuery={onNewQuery}
                onOpenTableData={onOpenTableData}
                onOpenTableStructure={onOpenTableStructure}
                activeConnectionIds={activeConnectionIds}
                onOpenConnection={handleOpenConnection}
                onCloseConnection={handleCloseConnection}
              />
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-[#7a9bb8]">
            <p className="text-sm">{t('explorer.selectActivityBar')}</p>
          </div>
        )}
      </div>

      {showModal && (
        <ConnectionModal
          onClose={() => { setShowModal(false); init(); }}
        />
      )}

      {showGroupModal && (
        <GroupModal
          onClose={() => setShowGroupModal(false)}
          onSuccess={() => { setShowGroupModal(false); init(); }}
        />
      )}
    </>
  );
};
