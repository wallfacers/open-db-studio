import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Edit3, Trash2, Plus, Copy, LucideIcon } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import { useQueryStore } from '../../../store/queryStore';
import { useConfirmStore } from '../../../store/confirmStore';

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
  const { tables, columns, deleteTable, loadProject, addTable, addColumn, openDrawer } = useErDesignerStore();
  const { openERDesignTab } = useQueryStore();

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
    await addColumn(tableId, {
      name: `column_${cols.length + 1}`,
      data_type: 'VARCHAR',
      nullable: true,
      default_value: null,
      is_primary_key: false,
      is_auto_increment: false,
      comment: null,
      length: null,
      scale: null,
      is_unique: false,
      unsigned: false,
      charset: null,
      collation: null,
      on_update: null,
      enum_values: null,
      sort_order: cols.length,
    });
    onClose();
  };

  const handleDuplicate = async () => {
    if (!table) return;
    const srcCols = columns[tableId] || [];
    const newTable = await addTable(`${table.name}_copy`, {
      x: table.position_x + 50,
      y: table.position_y + 50,
    });
    for (let i = 0; i < srcCols.length; i++) {
      const col = srcCols[i];
      await addColumn(newTable.id, {
        name: col.name,
        data_type: col.data_type,
        nullable: col.nullable,
        default_value: col.default_value,
        is_primary_key: col.is_primary_key,
        is_auto_increment: col.is_auto_increment,
        comment: col.comment,
        length: col.length,
        scale: col.scale,
        is_unique: col.is_unique,
        unsigned: col.unsigned,
        charset: col.charset,
        collation: col.collation,
        on_update: col.on_update,
        enum_values: col.enum_values,
        sort_order: i,
      });
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
      className="fixed bg-[var(--background-base)] border border-[var(--border-default)] rounded-md shadow-lg py-1 z-[200] min-w-[140px]"
      style={{ left: x, top: y }}
    >
      {menuItems.map((item, idx) => {
        if (item.type === 'divider') {
          return <div key={idx} className="h-px bg-[var(--border-default)] my-1" />;
        }
        return (
          <div
            key={idx}
            className={`flex items-center px-3 py-1.5 cursor-pointer text-xs ${
              item.danger
                ? 'text-[var(--error)] hover:bg-[var(--danger-hover-bg)]'
                : 'text-[var(--foreground-default)] hover:bg-[var(--background-hover)]'
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
