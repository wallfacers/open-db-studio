import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Edit3, Trash2, Link2, Unlink, Download, Table2, LucideIcon } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useErDesignerStore } from '../../../store/erDesignerStore';

interface ProjectContextMenuProps {
  x: number;
  y: number;
  projectId: number;
  onClose: () => void;
}

interface MenuItem {
  icon?: LucideIcon;
  label?: string;
  onClick?: () => void;
  show?: boolean;
  danger?: boolean;
  type?: 'divider';
}

export const ProjectContextMenu: React.FC<ProjectContextMenuProps> = ({ x, y, projectId, onClose }) => {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const { projects, deleteProject, loadProject, addTable } = useErDesignerStore();

  const project = projects.find(p => p.id === projectId);

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
    if (!confirm(t('erDesigner.confirmDeleteProject') || '确定删除此项目？')) return;
    await deleteProject(projectId);
    onClose();
  };

  const handleRename = () => {
    // TODO: Open rename dialog
    onClose();
  };

  const handleBindConnection = () => {
    // TODO: Open bind connection dialog
    onClose();
  };

  const handleUnbind = () => {
    // TODO: Unbind connection
    onClose();
  };

  const handleAddTable = async () => {
    await loadProject(projectId);
    await addTable('new_table', { x: 100, y: 100 });
    onClose();
  };

  const handleExport = () => {
    // TODO: Export project as JSON
    onClose();
  };

  const menuItems: MenuItem[] = [
    { icon: Table2, label: t('erDesigner.newTable') || '新建表', onClick: handleAddTable },
    { type: 'divider' },
    { icon: Edit3, label: t('common.rename') || '重命名', onClick: handleRename },
    { icon: Link2, label: t('erDesigner.bindConnection') || '绑定连接', onClick: handleBindConnection, show: !project?.connection_id },
    { icon: Unlink, label: t('erDesigner.unbindConnection') || '解除绑定', onClick: handleUnbind, show: !!project?.connection_id },
    { icon: Download, label: t('common.export') || '导出 JSON', onClick: handleExport },
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
        if (item.show === false) return null;
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

export default ProjectContextMenu;
