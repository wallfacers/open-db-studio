import React, { useEffect, useState } from 'react';
import { Plus, RefreshCw, Search, X, DatabaseZap, FolderPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTreeStore, loadPersistedTreeExpandedIds } from '../../store/treeStore';
import { useConnectionStore, loadOpenedConnectionIds } from '../../store/connectionStore';
import { DBTree } from './DBTree';
import { ConnectionModal } from '../ConnectionModal';
import { GroupModal } from '../GroupModal';
import { Tooltip } from '../common/Tooltip';
import { invoke } from '@tauri-apps/api/core';
import { connNodeId } from '../../utils/nodeId';
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
  // 新增指标相关回调
  onOpenMetricTab?: (metricId: number, title: string, connectionId?: number) => void;
  onOpenMetricListTab?: (
    scope: { connectionId: number; database?: string; schema?: string },
    title: string
  ) => void;
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
  // 新增
  onOpenMetricTab,
  onOpenMetricListTab,
}) => {
  const { t } = useTranslation();
  const { init, refresh, nodes } = useTreeStore();
  const { activeConnectionIds, openConnection, closeConnection } = useConnectionStore();
  const [showModal, setShowModal] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);

  // 递归恢复节点展开状态（深度优先）
  const restoreNodeExpansion = async (nodeId: string, savedExpandedIds: Set<string>): Promise<void> => {
    if (!savedExpandedIds.has(nodeId)) return;

    const store = useTreeStore.getState();
    const node = store.nodes.get(nodeId);
    if (!node) return;

    // 先加载子节点（若未加载），避免 toggleExpand 内部的 fire-and-forget loadChildren 冲突
    if (!node.loaded) {
      await useTreeStore.getState().loadChildren(nodeId);
    }

    // 展开节点（避免重复）
    if (!useTreeStore.getState().expandedIds.has(nodeId)) {
      useTreeStore.getState().toggleExpand(nodeId);
    }

    // 递归恢复子节点
    const currentNodes = useTreeStore.getState().nodes;
    const children = [...currentNodes.values()].filter((n) => n.parentId === nodeId);
    await Promise.allSettled(
      children
        .filter((child) => savedExpandedIds.has(child.id))
        .map((child) => restoreNodeExpansion(child.id, savedExpandedIds))
    );
  };

  // 恢复单个连接的树展开状态
  const restoreConnectionTree = async (
    connectionId: number,
    savedExpandedIds: Set<string>
  ): Promise<void> => {
    const nodeId = connNodeId(connectionId);
    if (!useTreeStore.getState().nodes.get(nodeId)) return;

    // 检测连接可用性
    let available = false;
    try {
      available = await invoke<boolean>('test_connection_by_id', { connectionId });
    } catch {
      available = false;
    }

    if (!available) return; // 不可用：保持默认折叠状态

    // 标记连接已打开
    openConnection(connectionId);

    // 异步获取版本（不阻断恢复）
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

    // 深度优先恢复展开状态
    await restoreNodeExpansion(nodeId, savedExpandedIds);
  };

  useEffect(() => {
    const restoreOpenedConnections = async () => {
      // 首次挂载（store 无数据）：初始化并恢复连接
      // 重新挂载（切页切回，store 已有数据）：跳过，Zustand 状态已保留，无需重复恢复
      if (useTreeStore.getState().nodes.size > 0) return;
      await init();

      const [savedIds, savedExpandedIds] = await Promise.all([
        loadOpenedConnectionIds(),
        loadPersistedTreeExpandedIds(),
      ]);

      if (savedIds.length === 0) return;

      // 先恢复各连接的子树（含可用性检测）
      await Promise.allSettled(
        savedIds.map((id) => restoreConnectionTree(id, savedExpandedIds))
      );

      // 再展开分组节点（group 是 connection 的父节点，必须单独处理）
      // 不递归进连接子树（已由上面处理），只展开 group 层本身
      for (const [nodeId, node] of useTreeStore.getState().nodes) {
        if (node.nodeType === 'group' && savedExpandedIds.has(nodeId)) {
          const storeNow = useTreeStore.getState();
          if (!storeNow.nodes.get(nodeId)?.loaded) {
            await storeNow.loadChildren(nodeId);
          }
          if (!useTreeStore.getState().expandedIds.has(nodeId)) {
            useTreeStore.getState().toggleExpand(nodeId);
          }
        }
      }
    };
    restoreOpenedConnections();
  }, []);

  const handleOpenConnection = async (connectionId: number) => {
    const nodeId = connNodeId(connectionId);
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

    const nodeId = connNodeId(connectionId);
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
        className="flex flex-col border-r border-border-default bg-background-base flex-shrink-0 relative"
        style={{ width: sidebarWidth }}
      >
        <div
          className="absolute right-[-2px] top-0 bottom-0 w-[4.5px] cursor-col-resize hover:bg-accent z-20 transition-colors"
          onMouseDown={handleSidebarResize}
        />

        {activeActivity === 'database' ? (
          <>
            <div className="h-10 flex items-center justify-between px-3 border-b border-border-default">
              <div className="flex items-center gap-2">
                <DatabaseZap size={14} className="text-accent" />
                <span className="font-medium text-foreground-default">{t('explorer.database')}</span>
              </div>
              <div className="flex items-center space-x-2 text-foreground-muted">
                <Tooltip content={t('groupModal.createTitle')}>
                  <FolderPlus
                    size={16}
                    className="cursor-pointer hover:text-foreground-default transition-colors duration-200"
                    onClick={() => setShowGroupModal(true)}
                  />
                </Tooltip>
                <Tooltip content={t('connectionModal.newConnection')}>
                  <Plus
                    size={16}
                    className="cursor-pointer hover:text-foreground-default transition-colors duration-200"
                    onClick={() => setShowModal(true)}
                  />
                </Tooltip>
                <Tooltip content={t('explorer.refresh')}>
                  <RefreshCw
                    size={16}
                    className="cursor-pointer hover:text-foreground-default transition-colors duration-200"
                    onClick={() => refresh()}
                  />
                </Tooltip>
              </div>
            </div>

            <div className="h-10 flex items-center px-2 border-b border-border-default">
              <div className="flex items-center bg-background-elevated border border-border-strong rounded px-2 py-1 flex-1 focus-within:border-accent-hover transition-colors">
                <Search size={14} className="text-foreground-muted mr-1" />
                <input
                  type="text"
                  placeholder={t('explorer.searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="bg-transparent border-none outline-none text-foreground-default w-full text-xs placeholder-foreground-muted"
                />
                {searchQuery && (
                  <Tooltip content={t('explorer.clearSearch')}>
                    <X
                      size={14}
                      className="text-foreground-muted ml-1 cursor-pointer hover:text-foreground-default transition-colors duration-200"
                      onClick={() => setSearchQuery('')}
                    />
                  </Tooltip>
                )}
              </div>
            </div>

            {nodes.size === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-foreground-muted">
                <DatabaseZap size={24} className="mx-auto mb-2 opacity-30" />
                <p>{t('explorer.noConnections')}</p>
                <p
                  className="mt-1 text-accent cursor-pointer hover:underline"
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
                onOpenMetricTab={onOpenMetricTab}
                onOpenMetricListTab={onOpenMetricListTab}
              />
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-foreground-muted">
            <p className="text-sm">{t('explorer.selectActivityBar')}</p>
          </div>
        )}
      </div>

      {showModal && (
        <ConnectionModal
          onClose={() => setShowModal(false)}
          onSuccess={() => { setShowModal(false); refresh(); }}
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
