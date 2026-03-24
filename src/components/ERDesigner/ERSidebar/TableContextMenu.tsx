import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Edit3, Trash2, Plus, Copy, LucideIcon } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useErDesignerStore } from '../../../store/erDesignerStore';

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
  const { deleteTable } = useErDesignerStore();

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
    if (!confirm(t('erDesigner.confirmDeleteTable') || '确定删除此表？')) return;
    await deleteTable(tableId);
    onClose();
  };

  const handleEdit = () => {
    // TODO: Open table edit dialog
    onClose();
  };

  const handleAddColumn = () => {
    // TODO: Open add column dialog
    onClose();
  };

  const handleDuplicate = () => {
    // TODO: Duplicate table
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
      className="fixed bg-[#0d1117] border border-[#1e2d42] rounded-md shadow-lg py-1 z-[200] min-w-[140px]"
      style={{ left: x, top: y }}
    >
      {menuItems.map((item, idx) => {
        if (item.type === 'divider') {
          return <div key={idx} className="h-px bg-[#1e2d42] my-1" />;
        }
        return (
          <div
            key={idx}
            className={`flex items-center px-3 py-1.5 cursor-pointer text-xs ${
              item.danger
                ? 'text-red-400 hover:bg-[#3d1f1f]'
                : 'text-[#c8daea] hover:bg-[#1a2639]'
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
