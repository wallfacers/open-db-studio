import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Edit3, Trash2, Plus, Copy, type LucideIcon } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import { useConfirmStore } from '../../../store/confirmStore';
import { useToastStore } from '../../../store/toastStore';
import { duplicateTable } from '../shared/duplicateTable';

interface ERTableContextMenuProps {
  x: number;
  y: number;
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

export default function ERTableContextMenu({ x, y, tableId, onClose }: ERTableContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const { tables, columns, deleteTable, addColumn, addTable, openDrawer } = useErDesignerStore();
  const { show: showToast, showError } = useToastStore();

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

  const handleEdit = () => {
    openDrawer(tableId);
    onClose();
  };

  const handleAddColumn = async () => {
    const cols = columns[tableId] || [];
    try {
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

  const menuItems: MenuItem[] = [
    { icon: Edit3, label: t('common.edit') || '编辑', onClick: handleEdit },
    { icon: Plus, label: t('erDesigner.addColumn') || '添加列', onClick: handleAddColumn },
    { icon: Copy, label: t('common.duplicate') || '复制表', onClick: handleDuplicate },
    { type: 'divider' },
    { icon: Trash2, label: t('common.delete') || '删除', onClick: handleDelete, danger: true },
  ];

  return createPortal(
    <div
      ref={menuRef}
      className="fixed bg-background-base border border-border-default rounded-md shadow-lg py-1 z-[200] min-w-[140px]"
      style={{ left: x, top: y }}
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
            {item.icon && <item.icon size={14} className="mr-2 flex-shrink-0" />}
            {item.label}
          </div>
        );
      })}
    </div>,
    document.body
  );
}
