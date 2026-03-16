import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useTreeStore } from '../../store/treeStore';
import { TreeNode } from './TreeNode';
import { ContextMenu } from './ContextMenu';
import { invoke } from '@tauri-apps/api/core';
import type { TreeNode as TreeNodeType } from '../../types';
import { TableManageDialog } from '../TableManageDialog';
import { IndexManager } from '../IndexManager';
import { AiCreateTableDialog } from '../AiCreateTableDialog';
import { ConnectionModal } from '../ConnectionModal';
import { GroupModal } from '../GroupModal';
import { DdlViewerDialog } from '../DdlViewerDialog';
import { TruncateConfirmDialog } from '../TruncateConfirmDialog';
import { ExportWizard } from '../ImportExport/ExportWizard';
import { BackupWizard } from '../ImportExport/BackupWizard';
import { ImportWizard } from '../ImportExport/ImportWizard';
import { CreateDatabaseDialog } from '../DatabaseManager/CreateDatabaseDialog';
import { useConnectionStore } from '../../store/connectionStore';
import { Folder, FolderX } from 'lucide-react';
import type { ToastLevel } from '../Toast';

interface DBTreeProps {
  searchQuery: string;
  showToast: (msg: string, level?: ToastLevel) => void;
  onNewQuery: (connectionId: number, connName: string, database?: string, schema?: string, initialSql?: string) => void;
  onOpenTableData: (tableName: string, connectionId: number, database?: string, schema?: string) => void;
  onOpenTableStructure: (connectionId: number, database?: string, schema?: string, tableName?: string) => void;
  activeConnectionIds: Set<number>;
  onOpenConnection: (connectionId: number) => void;
  onCloseConnection: (connectionId: number) => void;
}

function computeVisibleNodes(
  nodes: Map<string, TreeNodeType>,
  expandedIds: Set<string>
): TreeNodeType[] {
  const result: TreeNodeType[] = [];

  function visit(parentId: string | null) {
    const children = Array.from(nodes.values())
      .filter(n => n.parentId === parentId)
      .sort((a, b) => {
        // connection/group 节点按 sortOrder 排序，其余按名称
        const isOrderable = a.nodeType === 'connection' || a.nodeType === 'group';
        if (isOrderable) {
          const diff = (a.meta.sortOrder ?? 0) - (b.meta.sortOrder ?? 0);
          if (diff !== 0) return diff;
        }
        return a.label.localeCompare(b.label);
      });
    for (const node of children) {
      result.push(node);
      if (expandedIds.has(node.id)) {
        visit(node.id);
      }
    }
  }

  visit(null);
  return result;
}

function getIndentLevel(node: TreeNodeType, nodes: Map<string, TreeNodeType>): number {
  let level = 0;
  let current = node;
  while (current.parentId !== null) {
    const parent = nodes.get(current.parentId);
    if (!parent) break;
    level++;
    current = parent;
  }
  return level;
}

export const DBTree: React.FC<DBTreeProps> = ({
  searchQuery,
  showToast,
  onNewQuery,
  onOpenTableData,
  onOpenTableStructure,
  activeConnectionIds,
  onOpenConnection,
  onCloseConnection,
}) => {
  const { t } = useTranslation();
  const { nodes, expandedIds, selectedId, loadingIds, toggleExpand, selectNode, refreshNode, search } = useTreeStore();

  const [contextMenu, setContextMenu] = useState<{ node: TreeNodeType; x: number; y: number } | null>(null);
  const [moveToGroupPicker, setMoveToGroupPicker] = useState<{
    connectionId: number;
    currentGroupId: string | null;
    x: number;
    y: number;
  } | null>(null);
  const groupPickerRef = useRef<HTMLDivElement>(null);

  const [tableManageDialog, setTableManageDialog] = useState<{ connectionId: number; tableName?: string; database?: string; schema?: string } | null>(null);
  const [indexManagerState, setIndexManagerState] = useState<{ connectionId: number; tableName: string } | null>(null);
  const [ddlViewer, setDdlViewer] = useState<{ connectionId: number; tableName: string; database?: string; schema?: string } | null>(null);
  const [truncateConfirm, setTruncateConfirm] = useState<{ connectionId: number; tableName: string; database?: string; schema?: string } | null>(null);
  const [showAiCreateTable, setShowAiCreateTable] = useState(false);
  const [editingConnId, setEditingConnId] = useState<number | null>(null);
  const [editingGroup, setEditingGroup] = useState<{ id: number; name: string; color: string | null } | null>(null);
  const [newConnGroupId, setNewConnGroupId] = useState<number | null | undefined>(undefined); // undefined=关闭，null=无分组，number=指定分组
  const [exportWizard, setExportWizard] = useState<{
    tableName?: string; connectionId: number; database?: string; schema?: string;
    initialScope?: import('../ImportExport/ExportWizard').ExportScope;
  } | null>(null);
  const [backupWizard, setBackupWizard] = useState<{
    connectionId: number;
    database: string;
    driver: 'mysql' | 'postgresql';
  } | null>(null);
  const [importWizard, setImportWizard] = useState<{
    tableName: string; connectionId: number; database?: string; schema?: string;
  } | null>(null);
  const [createDb, setCreateDb] = useState<{
    connectionId: number; driver: string;
  } | null>(null);

  const { connections, loadConnections } = useConnectionStore();

  useEffect(() => { loadConnections(); }, []);

  // 分组选择器点击外部关闭
  useEffect(() => {
    if (!moveToGroupPicker) return;
    const handler = (e: MouseEvent) => {
      if (groupPickerRef.current && !groupPickerRef.current.contains(e.target as Node)) {
        setMoveToGroupPicker(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [moveToGroupPicker]);

  const visibleNodes = useMemo(() => {
    if (searchQuery.trim()) return search(searchQuery);
    return computeVisibleNodes(nodes, expandedIds);
  }, [nodes, expandedIds, searchQuery, search]);

  // 所有分组节点，用于分组选择器
  const groupNodes = useMemo(() =>
    Array.from(nodes.values()).filter(n => n.nodeType === 'group'),
    [nodes]
  );

  const handleNodeClick = (node: TreeNodeType) => {
    selectNode(node.id);
    if (!node.hasChildren) return;

    if (node.nodeType === 'connection') {
      if (nodes.get(node.id)?.loaded) {
        toggleExpand(node.id);
      } else {
        onOpenConnection(getConnectionId(node));
      }
    } else {
      toggleExpand(node.id);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, node: TreeNodeType) => {
    e.preventDefault();
    setContextMenu({ node, x: e.clientX, y: e.clientY });
  };

  const getConnectionId = (node: TreeNodeType): number => node.meta.connectionId ?? 0;

  const getConnName = (node: TreeNodeType): string => {
    if (node.nodeType === 'connection') return node.label;
    const connId = node.meta.connectionId;
    if (!connId) return '';
    const connNode = nodes.get(`conn_${connId}`);
    return connNode?.label ?? '';
  };

  const getDriver = (connectionId: number): string => {
    return connections.find(c => c.id === connectionId)?.driver ?? 'mysql';
  };

  const normalizeDriver = (raw: string): 'mysql' | 'postgresql' => {
    const lower = raw.toLowerCase();
    if (lower === 'mysql') return 'mysql';
    if (lower.startsWith('pg') || lower.startsWith('postgres')) return 'postgresql';
    return 'mysql';
  };

  const quoteIdentifier = (name: string, driver: string): string => {
    const isPgOrOracle = driver === 'postgres' || driver === 'postgresql' || driver === 'oracle';
    return isPgOrOracle ? `"${name}"` : `\`${name}\``;
  };

  const buildSelectSql = (tableName: string, connectionId: number, columnName?: string): string => {
    const driver = getDriver(connectionId);
    const q = (name: string) => quoteIdentifier(name, driver);
    const cols = columnName ? q(columnName) : '*';
    return `SELECT ${cols} FROM ${q(tableName)} LIMIT 100;`;
  };

  const handleMoveToGroup = async (connectionId: number, groupId: number | null) => {
    await invoke('move_connection_to_group', { connectionId, groupId });
    useTreeStore.getState().init();
    setMoveToGroupPicker(null);
  };

  if (visibleNodes.length === 0 && !searchQuery) {
    return (
      <div className="px-3 py-4 text-center text-xs text-[#7a9bb8]">
        <p>{t('dbTree.noConnections')}</p>
      </div>
    );
  }

  if (visibleNodes.length === 0 && searchQuery) {
    return (
      <div className="px-3 py-4 text-center text-xs text-[#7a9bb8]">
        <p>{t('dbTree.noSearchResults')}</p>
      </div>
    );
  }

  // 分组选择器位置边界处理
  const pickerWidth = 200;
  const pickerItemCount = groupNodes.length + (moveToGroupPicker?.currentGroupId ? 1 : 0);
  const pickerHeight = pickerItemCount * 30 + 40;
  const safePickerX = moveToGroupPicker
    ? Math.min(moveToGroupPicker.x, window.innerWidth - pickerWidth - 8)
    : 0;
  const safePickerY = moveToGroupPicker
    ? Math.min(moveToGroupPicker.y, window.innerHeight - pickerHeight - 8)
    : 0;

  return (
    <div className="flex-1 overflow-y-auto py-1">
      {visibleNodes.map(node => (
        <TreeNode
          key={node.id}
          node={node}
          indent={searchQuery ? 0 : getIndentLevel(node, nodes)}
          isExpanded={expandedIds.has(node.id)}
          isSelected={selectedId === node.id}
          isLoading={loadingIds.has(node.id)}
          isActive={node.nodeType === 'connection'
            ? activeConnectionIds.has(getConnectionId(node))
            : undefined}
          onClick={() => handleNodeClick(node)}
          onContextMenu={(e) => handleContextMenu(e, node)}
        />
      ))}

      {contextMenu && (
        <ContextMenu
          node={contextMenu.node}
          x={contextMenu.x}
          y={contextMenu.y}
          isConnected={activeConnectionIds.has(getConnectionId(contextMenu.node))}
          onClose={() => setContextMenu(null)}
          onOpenConnection={() => onOpenConnection(getConnectionId(contextMenu.node))}
          onCloseConnection={() => onCloseConnection(getConnectionId(contextMenu.node))}
          onNewQuery={() => {
            const n = contextMenu.node;
            const connId = getConnectionId(n);
            let initialSql: string | undefined;
            if (n.nodeType === 'table' || n.nodeType === 'view') {
              initialSql = buildSelectSql(n.label, connId);
            } else if (n.nodeType === 'column') {
              const parentNode = nodes.get(n.parentId ?? '');
              const tableName = parentNode?.label ?? 'table_name';
              initialSql = buildSelectSql(tableName, connId, n.label);
            }
            // connection / database / schema / category: initialSql = undefined, only pre-select context
            onNewQuery(connId, getConnName(n), n.meta.database, n.meta.schema, initialSql);
          }}
          onRefresh={() => refreshNode(contextMenu.node.id)}
          onMoveToGroup={() => {
            const n = contextMenu.node;
            setContextMenu(null);
            setMoveToGroupPicker({
              connectionId: getConnectionId(n),
              currentGroupId: n.parentId,
              x: contextMenu.x,
              y: contextMenu.y,
            });
          }}
          onEditConnection={() => setEditingConnId(getConnectionId(contextMenu.node))}
          onDeleteConnection={async () => {
            if (!window.confirm(t('dbTree.confirmDeleteConnection'))) return;
            await invoke('delete_connection', { id: getConnectionId(contextMenu.node) });
            useTreeStore.getState().init();
            showToast(t('dbTree.connectionDeleted'), 'success');
          }}
          onCreateTable={() => {
            const n = contextMenu.node;
            setContextMenu(null);
            onOpenTableStructure(getConnectionId(n), n.meta.database, n.meta.schema, undefined);
          }}
          onAiCreateTable={() => setShowAiCreateTable(true)}
          onOpenTableData={() => {
            const n = contextMenu.node;
            onOpenTableData(n.label, getConnectionId(n), n.meta.database, n.meta.schema);
          }}
          onEditTable={() => {
            const n = contextMenu.node;
            setContextMenu(null);
            onOpenTableStructure(getConnectionId(n), n.meta.database, n.meta.schema, n.label);
          }}
          onManageIndexes={() => {
            const n = contextMenu.node;
            setIndexManagerState({ connectionId: getConnectionId(n), tableName: n.label });
          }}
          onViewDdl={() => {
            const n = contextMenu.node;
            setContextMenu(null);
            setDdlViewer({ connectionId: getConnectionId(n), tableName: n.label, database: n.meta.database, schema: n.meta.schema });
          }}
          onTruncateTable={() => {
            const n = contextMenu.node;
            setContextMenu(null);
            setTruncateConfirm({ connectionId: getConnectionId(n), tableName: n.label, database: n.meta.database, schema: n.meta.schema });
          }}
          onDropTable={async () => {
            const n = contextMenu.node;
            if (!window.confirm(t('tableManageDialog.confirmDrop', { table: n.label }))) return;
            setContextMenu(null);
            const driver = getDriver(getConnectionId(n));
            const isPostgres = driver === 'postgres' || driver === 'postgresql';
            const q = (name: string) => isPostgres ? `"${name}"` : `\`${name}\``;
            const sql = isPostgres
              ? n.meta.schema
                ? `DROP TABLE ${q(n.meta.schema)}.${q(n.label)}`
                : `DROP TABLE ${q(n.label)}`
              : `DROP TABLE ${q(n.label)}`;
            try {
              await invoke('execute_query', {
                connectionId: getConnectionId(n),
                sql,
                database: n.meta.database ?? null,
                schema: n.meta.schema ?? null,
              });
              const parentId = Array.from(useTreeStore.getState().nodes.values())
                .find(nd => nd.label === n.label && nd.nodeType === 'table')?.parentId ?? '';
              if (parentId) refreshNode(parentId);
              showToast(t('dbTree.operationSuccess'), 'success');
            } catch (e) {
              showToast(String(e), 'error');
            }
          }}
          onCopyName={() => {
            navigator.clipboard.writeText(contextMenu.node.label);
            showToast(t('dbTree.nameCopied'), 'success');
          }}
          onCreateGroup={() => {/* 入口在 Explorer 头部 FolderPlus 按钮 */}}
          onCreateConnectionInGroup={() => {
            const groupIdStr = contextMenu.node.id.replace('group_', '');
            setNewConnGroupId(parseInt(groupIdStr, 10));
          }}
          onRenameGroup={() => {
            const n = contextMenu.node;
            const groupId = parseInt(n.id.replace('group_', ''), 10);
            setEditingGroup({ id: groupId, name: n.label, color: n.meta.color ?? null });
          }}
          onDeleteGroup={async () => {
            if (!window.confirm(t('dbTree.confirmDeleteGroup'))) return;
            const groupId = parseInt(contextMenu.node.id.replace('group_', ''), 10);
            await invoke('delete_group', { id: groupId });
            useTreeStore.getState().init();
            showToast(t('dbTree.groupDeleted'), 'success');
          }}
          onExportTableData={() => {
            const n = contextMenu.node;
            setContextMenu(null);
            setExportWizard({ tableName: n.label, connectionId: getConnectionId(n), database: n.meta?.database, schema: n.meta?.schema });
          }}
          onImportToTable={() => {
            const n = contextMenu.node;
            setContextMenu(null);
            setImportWizard({ tableName: n.label, connectionId: getConnectionId(n), database: n.meta?.database, schema: n.meta?.schema });
          }}
          onCreateDatabase={() => {
            const n = contextMenu.node;
            setContextMenu(null);
            setCreateDb({ connectionId: getConnectionId(n), driver: getDriver(getConnectionId(n)) });
          }}
          onExportDatabase={
            (contextMenu.node.nodeType === 'database' || contextMenu.node.nodeType === 'schema')
              ? () => {
                  const n = contextMenu.node;
                  setContextMenu(null);
                  setExportWizard({
                    connectionId: getConnectionId(n),
                    database: n.meta.database ?? n.label,
                    schema: n.meta.schema,
                    initialScope: 'database',
                  });
                }
              : undefined
          }
          onBackupDatabase={
            (contextMenu.node.nodeType === 'database' || contextMenu.node.nodeType === 'schema')
              ? () => {
                  const n = contextMenu.node;
                  setContextMenu(null);
                  setBackupWizard({
                    connectionId: getConnectionId(n),
                    database: n.meta.database ?? n.label,
                    driver: normalizeDriver(getDriver(getConnectionId(n))),
                  });
                }
              : undefined
          }
          onExportMultiTable={
            (contextMenu.node.nodeType === 'category' && contextMenu.node.meta.objectName === 'tables')
              ? () => {
                  const n = contextMenu.node;
                  setContextMenu(null);
                  setExportWizard({
                    connectionId: getConnectionId(n),
                    database: n.meta.database,
                    schema: n.meta.schema,
                    initialScope: 'multi_table',
                  });
                }
              : undefined
          }
        />
      )}

      {/* 分组选择器浮层 */}
      {moveToGroupPicker && (
        <div
          ref={groupPickerRef}
          className="fixed z-50 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg py-1 min-w-[180px]"
          style={{ left: safePickerX, top: safePickerY }}
        >
          <div className="px-3 py-1 text-[10px] text-[#4a6480] uppercase tracking-wide select-none">
            {t('contextMenu.moveToGroup')}
          </div>
          <div className="h-px bg-[#2a3f5a] my-1" />
          {groupNodes.length === 0 ? (
            <div className="px-3 py-1.5 text-xs text-[#4a6480]">—</div>
          ) : (
            groupNodes.map(g => (
              <button
                key={g.id}
                className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-[#1a2639] hover:text-white ${
                  moveToGroupPicker.currentGroupId === g.id
                    ? 'text-[#00c9a7]'
                    : 'text-[#c8daea]'
                }`}
                onClick={() => handleMoveToGroup(
                  moveToGroupPicker.connectionId,
                  parseInt(g.id.replace('group_', ''), 10)
                )}
              >
                <Folder size={13} />
                {g.label}
              </button>
            ))
          )}
          {/* 当前连接在某个分组中，才显示"取消分组"选项 */}
          {moveToGroupPicker.currentGroupId !== null && (
            <>
              <div className="h-px bg-[#2a3f5a] my-1" />
              <button
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-[#c8daea] hover:bg-[#1a2639] hover:text-white"
                onClick={() => handleMoveToGroup(moveToGroupPicker.connectionId, null)}
              >
                <FolderX size={13} />
                {t('contextMenu.noGroup')}
              </button>
            </>
          )}
        </div>
      )}

      {tableManageDialog && (
        <TableManageDialog
          connectionId={tableManageDialog.connectionId}
          tableName={tableManageDialog.tableName}
          database={tableManageDialog.database}
          schema={tableManageDialog.schema}
          onClose={() => setTableManageDialog(null)}
          onSuccess={() => {
            setTableManageDialog(null);
            showToast(t('dbTree.operationSuccess'), 'success');
          }}
          showToast={showToast}
        />
      )}

      {indexManagerState && (
        <IndexManager
          connectionId={indexManagerState.connectionId}
          tableName={indexManagerState.tableName}
          onClose={() => setIndexManagerState(null)}
          showToast={showToast}
        />
      )}

      {showAiCreateTable && (
        <AiCreateTableDialog
          onClose={() => setShowAiCreateTable(false)}
          showToast={showToast}
          onRefresh={() => {}}
        />
      )}

      {editingConnId !== null && (
        <ConnectionModal
          connection={connections.find(c => c.id === editingConnId)}
          onClose={() => {
            setEditingConnId(null);
            useTreeStore.getState().init();
          }}
        />
      )}

      {newConnGroupId !== undefined && (
        <ConnectionModal
          defaultGroupId={newConnGroupId}
          onClose={() => {
            setNewConnGroupId(undefined);
            useTreeStore.getState().init();
          }}
        />
      )}

      {editingGroup !== null && (
        <GroupModal
          group={editingGroup}
          onClose={() => setEditingGroup(null)}
          onSuccess={() => {
            setEditingGroup(null);
            useTreeStore.getState().init();
          }}
        />
      )}

      {ddlViewer && (
        <DdlViewerDialog
          connectionId={ddlViewer.connectionId}
          tableName={ddlViewer.tableName}
          database={ddlViewer.database}
          schema={ddlViewer.schema}
          onClose={() => setDdlViewer(null)}
        />
      )}

      {truncateConfirm && (
        <TruncateConfirmDialog
          connectionId={truncateConfirm.connectionId}
          tableName={truncateConfirm.tableName}
          database={truncateConfirm.database}
          schema={truncateConfirm.schema}
          onClose={() => setTruncateConfirm(null)}
          onSuccess={() => {
            const parentId = Array.from(useTreeStore.getState().nodes.values())
              .find(n => n.label === truncateConfirm.tableName && n.nodeType === 'table')?.parentId ?? '';
            if (parentId) refreshNode(parentId);
          }}
          showToast={showToast}
        />
      )}

      {exportWizard && (
        <ExportWizard
          defaultTable={exportWizard.tableName}
          connectionId={exportWizard.connectionId}
          database={exportWizard.database}
          schema={exportWizard.schema}
          initialScope={exportWizard.initialScope}
          onClose={() => setExportWizard(null)}
        />
      )}

      {backupWizard && (
        <BackupWizard
          connectionId={backupWizard.connectionId}
          database={backupWizard.database}
          driver={backupWizard.driver}
          onClose={() => setBackupWizard(null)}
        />
      )}

      {importWizard && (
        <ImportWizard
          defaultTable={importWizard.tableName}
          connectionId={importWizard.connectionId}
          database={importWizard.database}
          schema={importWizard.schema}
          onClose={() => setImportWizard(null)}
        />
      )}

      {createDb && (
        <CreateDatabaseDialog
          connectionId={createDb.connectionId}
          driver={createDb.driver}
          onClose={() => setCreateDb(null)}
          onSuccess={(dbName, switchTo) => {
            const connId = createDb.connectionId;
            setCreateDb(null);
            refreshNode(`conn_${connId}`);
            if (switchTo) {
              showToast(`已创建数据库 ${dbName}`, 'success');
            }
          }}
        />
      )}
    </div>
  );
};
