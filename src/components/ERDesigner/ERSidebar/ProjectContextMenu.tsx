import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Edit3, Trash2, Link2, Unlink, Download, Table2, LucideIcon, FolderOpen } from 'lucide-react';
import { createPortal } from 'react-dom';
import { emit } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import { useQueryStore } from '../../../store/queryStore';
import { useConfirmStore } from '../../../store/confirmStore';

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
  const { projects, tables, deleteProject, loadProject, addTable, updateProject, unbindConnection, exportJson } = useErDesignerStore();
  const { openERDesignTab } = useQueryStore();

  const project = projects.find(p => p.id === projectId);

  const [renaming, setRenaming] = useState(false);
  const [renameName, setRenameName] = useState(project?.name || '');
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  useEffect(() => {
    if (renaming) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renaming]);

  const handleDelete = async () => {
    const ok = await useConfirmStore.getState().confirm({
      title: t('common.delete') || '删除',
      message: t('erDesigner.confirmDeleteProject') || '确定删除此项目？',
      variant: 'danger',
    });
    if (!ok) return;
    await deleteProject(projectId);
    onClose();
  };

  const handleRename = () => {
    setRenaming(true);
  };

  const handleRenameConfirm = async () => {
    const trimmed = renameName.trim();
    if (trimmed && trimmed !== project?.name) {
      try {
        await updateProject(projectId, { name: trimmed });
      } catch (e: any) {
        const msg = typeof e === 'string' ? e : e?.message || '';
        if (msg.includes('已存在') || msg.includes('already exists')) {
          alert(t('erDesigner.projectNameExists') || '项目名称已存在');
          return; // Don't close menu, let user retry
        }
      }
    }
    onClose();
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRenameConfirm();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  const handleBindConnection = () => {
    // Open the ER canvas tab which has the bind dialog, then trigger it
    openERDesignTab(projectId, project?.name || '');
    onClose();
    // Dispatch event to open bind dialog on the canvas
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('er-open-bind-dialog', { detail: { projectId } }));
    }, 100);
  };

  const handleUnbind = async () => {
    const ok = await useConfirmStore.getState().confirm({
      title: t('erDesigner.unbindConnection') || '解除绑定',
      message: t('erDesigner.confirmUnbind') || '确定解除绑定？',
      variant: 'danger',
    });
    if (!ok) return;
    await unbindConnection(projectId);
    onClose();
  };

  const handleAddTable = async () => {
    await loadProject(projectId);
    const existing = new Set(tables.map(t => t.name));
    let name = 'new_table';
    let i = 1;
    while (existing.has(name)) {
      name = `new_table_${++i}`;
    }
    await addTable(projectId, name, { x: 100, y: 100 });
    // Open the ER design tab so the user can see the new table
    openERDesignTab(projectId, project?.name || '');
    onClose();
    // If canvas was already mounted, trigger reload to show the new node
    emit('er-canvas-reload', { projectId });
  };

  const handleExport = async () => {
    try {
      const json = await exportJson(projectId);
      const defaultFileName = project?.name ? `${project.name}.json` : 'er-project.json';
      const path = await save({
        defaultPath: defaultFileName,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!path) return;
      await invoke('write_text_file', { path, content: json });
    } catch (e) {
      console.error('Export failed:', e);
    }
    onClose();
  };

  const handleOpen = () => {
    openERDesignTab(projectId, project?.name || '');
    onClose();
  };

  if (renaming) {
    return createPortal(
      <div
        ref={menuRef}
        className="fixed bg-background-base border border-border-default rounded-md shadow-lg p-2 z-[200] min-w-[180px]"
        style={{ left: x, top: y }}
      >
        <input
          ref={renameRef}
          type="text"
          value={renameName}
          onChange={(e) => setRenameName(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          onBlur={handleRenameConfirm}
          className="w-full bg-background-hover border border-border-strong rounded px-2 py-1 text-xs text-foreground-default focus:outline-none focus:border-accent"
        />
      </div>,
      document.body
    );
  }

  const menuItems: MenuItem[] = [
    { icon: FolderOpen, label: t('common.open') || '打开', onClick: handleOpen },
    { icon: Table2, label: t('erDesigner.newTable') || '新建表', onClick: handleAddTable },
    { type: 'divider' },
    { icon: Edit3, label: t('common.rename') || '重命名', onClick: handleRename },
    { icon: Link2, label: t('erDesigner.bindConnection') || '绑定连接', onClick: handleBindConnection, show: !project?.connection_id },
    { icon: Unlink, label: t('erDesigner.unbindConnection') || '解除绑定', onClick: handleUnbind, show: !!project?.connection_id },
    { icon: Download, label: t('erDesigner.exportJson') || '导出 JSON', onClick: handleExport },
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
    >
      {menuItems.map((item, idx) => {
        if (item.type === 'divider') {
          return <div key={idx} className="h-px bg-border-default my-1" />;
        }
        if (item.show === false) return null;
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

export default ProjectContextMenu;
