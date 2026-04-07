import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Edit3, Trash2, Plus, Copy, LucideIcon } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import { useQueryStore } from '../../../store/queryStore';
import { useConfirmStore } from '../../../store/confirmStore';
import { useToastStore } from '../../../store/toastStore';
import { createDefaultColumn } from '../shared/defaultColumn';
import { duplicateTable } from '../shared/duplicateTable';

interface TableContextMenuProps {
  x: number;
  y: number;
  projectId: number;
  tableId: number;
  onClose: () => void;
}

interface MenuItem {
  icon?: LucideIcon;
  label?: string;
  onClick?: () => void;
  danger?: boolean;
  type?: 'divider';
}

export const TableContextMenu: React.FC<TableContextMenuProps> = ({ x, y, projectId, tableId, onClose }) => {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const { tables, columns, deleteTable, addTable, addColumn, openDrawer } = useErDesignerStore();
  const { openERDesignTab } = useQueryStore();
  const showToast = useToastStore(s => s.show);
  const showError = useToastStore(s => s.showError);

  const table = tables.find(t => t.id === tableId);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const handleDelete = async () => {
    const ok = await useConfirmStore.getState().confirm({
      title: t('common.delete') || '删除',
      message: t('erDesigner.confirmDeleteTable') || '确定删除此表？',
      variant: 'danger',
    });
    if (!ok) return;
    await deleteTable(tableId);
    onClose();
  };

  const handleEdit = () => {
    openERDesignTab(projectId, table?.name || '');
    openDrawer(tableId);
    onClose();
  };

  const handleAddColumn = async () => {
    const cols = columns[tableId] || [];
    try {
      await addColumn(tableId, createDefaultColumn(cols.length));
    } catch (e) {
      console.error('Failed to add column:', e);
      showError(`添加列失败: ${e}`);
    }
    onClose();
  };

  const handleDuplicate = async () => {
    if (!table) return;
    try {
      await duplicateTable(table, columns[tableId] || [], addTable, addColumn);
      showToast('表已复制', 'success');
    } catch (e) {
      console.error('Failed to duplicate table:', e);
      showError(`复制表失败: ${e}`);
    }
    onClose();
  };

  const menuItems: MenuItem[] = [
    { icon: Edit3, label: t('common.edit') || '编辑', onClick: handleEdit },
    { icon: Plus, label: t('erDesigner.addColumn') || '添加列', onClick: handleAddColumn },
    { icon: Copy, label: t('common.duplicate') || '复制表', onClick: handleDuplicate },
    { type: 'divider' },
    { icon: Trash2, label: t('common.delete') || '删除', onClick: handleDelete, danger: true },
  ];

  const renderIcon = (Icon: LucideIcon | undefined) => {
    if (!Icon) return null;
    return <Icon size={14} className="mr-2 flex-shrink-0" />;
  };

  return createPortal(
    <div
      ref={menuRef}
      className="fixed bg-background-base border border-border-default rounded-md shadow-lg py-1 z-[200] min-w-[140px]"
      style={{ left: x, top: y }}
      onClick={e => e.stopPropagation()}
    >
      {menuItems.map((item, idx) => {
        if (item.type === 'divider') {
          return <div key={idx} className="h-px bg-border-default my-1" />;
        }
        return (
          <div
            key={idx}
            className={`flex items-center px-3 py-1.5 cursor-pointer text-xs transition-colors duration-150 ${
              item.danger
                ? 'text-error hover:bg-danger-hover-bg'
                : 'text-foreground-default hover:bg-background-hover'
            }`}
            onClick={item.onClick}
          >
            {renderIcon(item.icon)}
            {item.label}
          </div>
        );
      })}
    </div>,
    document.body
  );
};

export default TableContextMenu;
