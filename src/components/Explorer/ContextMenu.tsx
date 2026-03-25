import React, { useLayoutEffect, useRef, useState } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside';
import {
  FilePlus, FilePlus2, Pencil, Trash2,
  RefreshCw, FileEdit, ListTree, Copy, Eye, FolderOpen, DatabaseZap, FolderInput,
  Code2, Eraser, Download, Upload, Database, Archive, PlugZap, Unplug, BarChart2, Plus
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TreeNode } from '../../types';

interface MenuItem {
  label: string;
  icon: React.ElementType;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  dividerBefore?: boolean;
}

interface ContextMenuProps {
  node: TreeNode;
  x: number;
  y: number;
  isConnected: boolean;
  onClose: () => void;
  onOpenConnection: () => void;
  onCloseConnection: () => void;
  onNewQuery: () => void;
  onRefresh: () => void;
  onEditConnection: () => void;
  onDeleteConnection: () => void;
  onCreateTable: () => void;
  onOpenTableData: () => void;
  onEditTable: () => void;
  onManageIndexes: () => void;
  onViewDdl: () => void;
  onTruncateTable: () => void;
  onDropTable: () => void;
  onExportTableData: () => void;
  onImportToTable: () => void;
  onCopyName: () => void;
  onMoveToGroup: () => void;
  onCreateGroup: () => void;
  onRenameGroup: () => void;
  onDeleteGroup: () => void;
  onCreateConnectionInGroup: () => void;
  onCreateDatabase: () => void;
  onExportDatabase?: () => void;
  onBackupDatabase?: () => void;
  onExportMultiTable?: () => void;
  // 新增指标相关回调
  onOpenMetricList?: () => void;
  onNewMetric?: () => void;
  onOpenMetric?: () => void;
  onDeleteMetric?: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  node, x, y, isConnected, onClose,
  onOpenConnection, onCloseConnection, onNewQuery, onRefresh,
  onEditConnection, onDeleteConnection, onCreateTable,
  onOpenTableData, onEditTable, onManageIndexes, onViewDdl, onTruncateTable, onDropTable,
  onExportTableData, onImportToTable, onCopyName,
  onMoveToGroup, onCreateGroup, onRenameGroup, onDeleteGroup, onCreateConnectionInGroup,
  onCreateDatabase,
  onExportDatabase,
  onBackupDatabase,
  onExportMultiTable,
  // 新增
  onOpenMetricList,
  onNewMetric,
  onOpenMetric,
  onDeleteMetric,
}) => {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; visible: boolean }>(
    { left: x, top: y, visible: false }
  );

  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const { width, height } = menuRef.current.getBoundingClientRect();
    const safeLeft = Math.max(8, Math.min(x, window.innerWidth - width - 8));
    const safeTop = Math.max(8, Math.min(y, window.innerHeight - height - 8));
    setPos({ left: safeLeft, top: safeTop, visible: true });
  }, [x, y]);

  useClickOutside(menuRef, onClose);

  const getMenuItems = (): MenuItem[] => {
    switch (node.nodeType) {
      case 'group':
        return [
          { label: t('contextMenu.createConnectionInGroup'), icon: DatabaseZap, onClick: onCreateConnectionInGroup },
          { label: t('contextMenu.renameGroup'), icon: FolderOpen, onClick: onRenameGroup, dividerBefore: true },
          { label: t('contextMenu.deleteGroup'), icon: Trash2, onClick: onDeleteGroup, danger: true, dividerBefore: true },
        ];
      case 'connection':
        return [
          isConnected
            ? { label: t('contextMenu.closeConnection', '断开连接'), icon: Unplug, onClick: onCloseConnection }
            : { label: t('contextMenu.openConnection', '连接'), icon: PlugZap, onClick: onOpenConnection },
          { label: t('contextMenu.newQuery'), icon: FilePlus, onClick: onNewQuery, disabled: !isConnected, dividerBefore: true },
          { label: t('contextMenu.refresh'), icon: RefreshCw, onClick: onRefresh, dividerBefore: true },
          { label: t('contextMenu.moveToGroup'), icon: FolderInput, onClick: onMoveToGroup, dividerBefore: true },
          { label: t('contextMenu.createDatabase', '新建数据库'), icon: Database, onClick: onCreateDatabase, disabled: !isConnected, dividerBefore: true },
          { label: t('contextMenu.editConnection'), icon: Pencil, onClick: onEditConnection },
          { label: t('contextMenu.deleteConnection'), icon: Trash2, onClick: onDeleteConnection, danger: true, dividerBefore: true },
        ];
      case 'database':
      case 'schema':
        return [
          { label: t('contextMenu.newQuery'), icon: FilePlus, onClick: onNewQuery },
          { label: t('contextMenu.refresh'), icon: RefreshCw, onClick: onRefresh },
          ...(onExportDatabase ? [{ label: t('contextMenu.exportDatabase'), icon: Download, onClick: onExportDatabase, dividerBefore: true }] : []),
          ...(onBackupDatabase ? [{ label: t('contextMenu.backupDatabase'), icon: Archive, onClick: onBackupDatabase }] : []),
        ];
      case 'category':
        if (node.meta.objectName === 'tables') {
          return [
            { label: t('contextMenu.newQuery'), icon: FilePlus, onClick: onNewQuery },
            { label: t('contextMenu.createTable'), icon: FilePlus2, onClick: onCreateTable, dividerBefore: true },
            { label: t('contextMenu.refresh'), icon: RefreshCw, onClick: onRefresh },
            ...(onExportMultiTable ? [{ label: t('contextMenu.exportMultiTable'), icon: Download, onClick: onExportMultiTable, dividerBefore: true }] : []),
          ];
        }
        return [
          { label: t('contextMenu.newQuery'), icon: FilePlus, onClick: onNewQuery },
          { label: t('contextMenu.refresh'), icon: RefreshCw, onClick: onRefresh },
        ];
      case 'table':
        return [
          { label: t('contextMenu.openTableData'), icon: Eye, onClick: onOpenTableData },
          { label: t('contextMenu.newQuery'), icon: FilePlus, onClick: onNewQuery },
          { label: t('contextMenu.viewDdl'), icon: Code2, onClick: onViewDdl },
          { label: t('contextMenu.editTableStructure'), icon: FileEdit, onClick: onEditTable, dividerBefore: true },
          { label: t('contextMenu.manageIndexes'), icon: ListTree, onClick: onManageIndexes },
          { label: t('contextMenu.exportData', '导出数据'), icon: Download, onClick: onExportTableData, dividerBefore: true },
          { label: t('contextMenu.importData', '导入数据'), icon: Upload, onClick: onImportToTable },
          { label: t('contextMenu.truncateTable'), icon: Eraser, onClick: onTruncateTable, danger: true, dividerBefore: true },
          { label: t('contextMenu.dropTable'), icon: Trash2, onClick: onDropTable, danger: true },
        ];
      case 'view':
        return [
          { label: t('contextMenu.openViewData'), icon: Eye, onClick: onOpenTableData },
          { label: t('contextMenu.newQuery'), icon: FilePlus, onClick: onNewQuery },
          { label: t('contextMenu.dropView'), icon: Trash2, onClick: onDropTable, danger: true, dividerBefore: true },
        ];
      case 'column':
        return [
          { label: t('contextMenu.newQuery'), icon: FilePlus, onClick: onNewQuery },
          { label: t('contextMenu.copyColumnName'), icon: Copy, onClick: onCopyName, dividerBefore: true },
        ];
      case 'metrics_folder':
        return [
          { label: t('contextMenu.newQuery'), icon: FilePlus, onClick: onNewQuery },
          { label: t('contextMenu.openMetricList'), icon: BarChart2, onClick: onOpenMetricList || (() => {}), disabled: !onOpenMetricList, dividerBefore: true },
          { label: t('contextMenu.newMetric'), icon: Plus, onClick: onNewMetric || (() => {}), disabled: !onNewMetric },
          { label: t('contextMenu.refresh'), icon: RefreshCw, onClick: onRefresh, dividerBefore: true },
        ];
      case 'metric':
        return [
          { label: t('contextMenu.openMetricList'), icon: Eye, onClick: onOpenMetric || (() => {}), disabled: !onOpenMetric },
          { label: t('contextMenu.deleteMetric'), icon: Trash2, onClick: onDeleteMetric || (() => {}), danger: true, dividerBefore: true },
        ];
      default:
        return [{ label: t('contextMenu.refresh'), icon: RefreshCw, onClick: onRefresh }];
    }
  };

  const items = getMenuItems();

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-[#0d1117] border border-[#1e2d42] rounded shadow-xl py-1 min-w-[160px]"
      style={{ left: pos.left, top: pos.top, visibility: pos.visible ? 'visible' : 'hidden' }}
    >
      {items.map((item) => (
        <React.Fragment key={item.label}>
          {item.dividerBefore && <div className="h-px bg-[#253347] my-1" />}
          <button
            disabled={item.disabled}
            className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ${
              item.disabled
                ? 'opacity-40 cursor-not-allowed text-[#7a9bb8]'
                : item.danger
                ? 'text-red-400 hover:bg-[#1a2639] hover:text-red-300'
                : 'text-[#c8daea] hover:bg-[#1a2639] hover:text-white'
            }`}
            onClick={() => { if (!item.disabled) { onClose(); item.onClick(); } }}
          >
            <item.icon size={13} />
            {item.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
};
