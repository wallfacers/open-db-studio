import React, { useEffect, useRef } from 'react';
import {
  FilePlus, FilePlus2, Pencil, Trash2,
  RefreshCw, FileEdit, ListTree, Copy, Eye, Sparkles, FolderOpen, DatabaseZap, FolderInput,
  Code2, Eraser, Download, Upload, Database, Archive
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
  onAiCreateTable: () => void;
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
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  node, x, y, isConnected, onClose,
  onOpenConnection, onCloseConnection, onNewQuery, onRefresh,
  onEditConnection, onDeleteConnection, onCreateTable, onAiCreateTable,
  onOpenTableData, onEditTable, onManageIndexes, onViewDdl, onTruncateTable, onDropTable,
  onExportTableData, onImportToTable, onCopyName,
  onMoveToGroup, onCreateGroup, onRenameGroup, onDeleteGroup, onCreateConnectionInGroup,
  onCreateDatabase,
  onExportDatabase,
  onBackupDatabase,
  onExportMultiTable,
}) => {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

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
          { label: t('contextMenu.newQuery'), icon: FilePlus, onClick: onNewQuery, disabled: !isConnected },
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
            { label: t('contextMenu.aiCreateTable'), icon: Sparkles, onClick: onAiCreateTable },
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
      default:
        return [{ label: t('contextMenu.refresh'), icon: RefreshCw, onClick: onRefresh }];
    }
  };

  const items = getMenuItems();

  const menuWidth = 160;
  const menuHeight = items.length * 28 + 8;
  const safeX = Math.min(x, window.innerWidth - menuWidth - 8);
  const safeY = Math.min(y, window.innerHeight - menuHeight - 8);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg py-1 min-w-[160px]"
      style={{ left: safeX, top: safeY }}
    >
      {items.map((item) => (
        <React.Fragment key={item.label}>
          {item.dividerBefore && <div className="h-px bg-[#2a3f5a] my-1" />}
          <button
            disabled={item.disabled}
            className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ${
              item.disabled
                ? 'opacity-40 cursor-not-allowed text-[#7a9bb8]'
                : item.danger
                ? 'text-red-400 hover:bg-[#1a2639] hover:text-red-300'
                : 'text-[#c8daea] hover:bg-[#1a2639] hover:text-white'
            }`}
            onClick={() => { if (!item.disabled) { item.onClick(); onClose(); } }}
          >
            <item.icon size={13} />
            {item.label}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
};
