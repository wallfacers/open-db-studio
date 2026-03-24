import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Plus, Database, Table2, Key, Link2, MoreVertical, Trash2, Edit3, Download, Upload, ChevronRight, ChevronDown } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import { useQueryStore } from '../../../store/queryStore';
import type { ErProject, ErTable, ErColumn } from '../../../types';
import { Tooltip } from '../../common/Tooltip';
import { DropdownSelect } from '../../common/DropdownSelect';
import { ProjectContextMenu } from './ProjectContextMenu';
import { TableContextMenu } from './TableContextMenu';

interface ERSidebarProps {
  width: number;
  hidden?: boolean;
}

export const ERSidebar: React.FC<ERSidebarProps> = ({ width, hidden }: ERSidebarProps) => {
  const { t } = useTranslation();
  const [expandedProjects, setExpandedProjects] = useState<Set<number>>(new Set());
  const [contextMenu, setContextMenu] = useState<{
    type: 'project' | 'table' | 'column';
    x: number;
    y: number;
    projectId?: number;
    tableId?: number;
    columnId?: number;
  } | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');

  const {
    projects,
    loadProjects,
    createProject,
    deleteProject,
    loadProject,
    activeProjectId,
    tables,
    columns,
    relations,
  } = useErDesignerStore();

  const { openERDesignTab } = useQueryStore();

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const toggleProject = (projectId: number) => {
    setExpandedProjects(prev => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
        // Load project data when expanding
        loadProject(projectId);
      }
      return next;
    });
  };

  const handleProjectClick = (project: ErProject) => {
    toggleProject(project.id);
  };

  const handleProjectDoubleClick = (project: ErProject) => {
    openERDesignTab(project.id, project.name);
  };

  const handleTableDoubleClick = (projectId: number, tableName: string) => {
    openERDesignTab(projectId, tableName);
  };

  const handleContextMenu = (e: React.MouseEvent, type: 'project' | 'table' | 'column', ids: { projectId?: number; tableId?: number; columnId?: number }) => {
    e.preventDefault();
    setContextMenu({ type, x: e.clientX, y: e.clientY, ...ids });
  };

  const closeContextMenu = () => setContextMenu(null);

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return;
    await createProject(newProjectName.trim());
    setNewProjectName('');
    setShowCreateDialog(false);
  };

  if (hidden) return null;

  const getTableColumns = (tableId: number): ErColumn[] => {
    return columns[tableId] || [];
  };

  const getRelationCount = (tableId: number): number => {
    return relations.filter(r => r.source_table_id === tableId || r.target_table_id === tableId).length;
  };

  return (
    <div
      style={{ width }}
      className="flex-shrink-0 bg-[#0d1117] border-r border-[#1e2d42] flex flex-col h-full"
      onClick={closeContextMenu}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-10 border-b border-[#1e2d42] bg-[#080d12]">
        <span className="text-xs text-[#c8daea] font-medium uppercase tracking-wider">
          {t('erDesigner.title') || 'ER 设计器'}
        </span>
        <Tooltip content={t('erDesigner.newProject') || '新建项目'}>
          <button
            className="p-1 rounded hover:bg-[#1e2d42] text-[#7a9bb8] hover:text-[#00c9a7]"
            onClick={() => setShowCreateDialog(true)}
          >
            <Plus size={14} />
          </button>
        </Tooltip>
      </div>

      {/* Project List */}
      <div className="flex-1 overflow-y-auto py-1">
        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[#7a9bb8] text-xs px-4 text-center">
            <Database size={32} className="mb-2 opacity-40" />
            <span>{t('erDesigner.noProjects') || '暂无 ER 项目'}</span>
            <span className="text-[10px] opacity-60 mt-1">{t('erDesigner.clickPlus') || '点击 + 创建新项目'}</span>
          </div>
        ) : (
          projects.map(project => (
            <div key={project.id} className="select-none">
              {/* Project Node */}
              <div
                className={`flex items-center px-2 py-1.5 cursor-pointer transition-colors group ${
                  activeProjectId === project.id ? 'bg-[#1a2639]' : 'hover:bg-[#151d28]'
                }`}
                onClick={() => handleProjectClick(project)}
                onDoubleClick={() => handleProjectDoubleClick(project)}
                onContextMenu={(e) => handleContextMenu(e, 'project', { projectId: project.id })}
              >
                {expandedProjects.has(project.id) ? (
                  <ChevronDown size={14} className="mr-1 text-[#7a9bb8] flex-shrink-0" />
                ) : (
                  <ChevronRight size={14} className="mr-1 text-[#7a9bb8] flex-shrink-0" />
                )}
                <FolderOpen size={14} className="mr-2 text-[#f59e0b] flex-shrink-0" />
                <span className="text-xs text-[#c8daea] flex-1 truncate">{project.name}</span>
                {project.connection_id && (
                  <Tooltip content={t('erDesigner.connectionBound') || '已绑定连接'}>
                    <Link2 size={10} className="mr-1 text-[#00c9a7]" />
                  </Tooltip>
                )}
                <button
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[#2a3f5a] text-[#7a9bb8]"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleContextMenu(e, 'project', { projectId: project.id });
                  }}
                >
                  <MoreVertical size={12} />
                </button>
              </div>

              {/* Tables under expanded project */}
              {expandedProjects.has(project.id) && (
                <div className="ml-4">
                  {tables
                    .filter(t => t.project_id === project.id)
                    .map(table => (
                      <div key={table.id}>
                        {/* Table Node */}
                        <div
                          className="flex items-center px-2 py-1 cursor-pointer transition-colors group hover:bg-[#151d28]"
                          onDoubleClick={() => handleTableDoubleClick(project.id, table.name)}
                          onContextMenu={(e) => handleContextMenu(e, 'table', { projectId: project.id, tableId: table.id })}
                        >
                          <Table2 size={12} className="mr-2 text-[#3794ff] flex-shrink-0" />
                          <span className="text-xs text-[#c8daea] flex-1 truncate">{table.name}</span>
                          <span className="text-[10px] text-[#7a9bb8] mr-1">
                            {getTableColumns(table.id).length}
                          </span>
                          {getRelationCount(table.id) > 0 && (
                            <Tooltip content={`${getRelationCount(table.id)} ${t('erDesigner.relations') || '个关系'}`}>
                              <Link2 size={10} className="text-[#a855f7] mr-1" />
                            </Tooltip>
                          )}
                        </div>

                        {/* Column Nodes */}
                        {getTableColumns(table.id).slice(0, 5).map(column => (
                          <div
                            key={column.id}
                            className="flex items-center px-2 py-0.5 ml-4 cursor-default hover:bg-[#151d28]"
                            onContextMenu={(e) => handleContextMenu(e, 'column', { projectId: project.id, tableId: table.id, columnId: column.id })}
                          >
                            {column.is_primary_key ? (
                              <Key size={10} className="mr-2 text-[#f59e0b] flex-shrink-0" />
                            ) : (
                              <div className="w-2.5 mr-2 flex-shrink-0" />
                            )}
                            <span className="text-[11px] text-[#7a9bb8] truncate">{column.name}</span>
                            <span className="text-[10px] text-[#5a6a7a] ml-1 truncate">{column.data_type}</span>
                          </div>
                        ))}
                        {getTableColumns(table.id).length > 5 && (
                          <div className="px-2 py-0.5 ml-4 text-[10px] text-[#5a6a7a]">
                            +{getTableColumns(table.id).length - 5} 更多列
                          </div>
                        )}
                      </div>
                    ))}

                  {/* Add Table Button */}
                  <div className="flex items-center px-2 py-1 cursor-pointer transition-colors hover:bg-[#151d28] text-[#7a9bb8]">
                    <Plus size={12} className="mr-2 flex-shrink-0" />
                    <span className="text-[11px]">{t('erDesigner.newTable') || '新建表'}</span>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Create Project Dialog */}
      {showCreateDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowCreateDialog(false)}>
          <div className="bg-[#151d28] border border-[#2a3f5a] rounded-lg p-4 w-72" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm text-[#c8daea] mb-3">{t('erDesigner.newProject') || '新建 ER 项目'}</h3>
            <input
              type="text"
              className="w-full px-3 py-2 bg-[#1a2639] border border-[#253347] rounded text-xs text-[#c8daea] placeholder-[#5a6a7a] focus:outline-none focus:border-[#009e84]"
              placeholder={t('erDesigner.projectName') || '项目名称'}
              value={newProjectName}
              onChange={e => setNewProjectName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateProject()}
              autoFocus
            />
            <div className="flex justify-end mt-3 gap-2">
              <button
                className="px-3 py-1.5 text-xs text-[#7a9bb8] hover:text-[#c8daea] rounded"
                onClick={() => setShowCreateDialog(false)}
              >
                {t('common.cancel') || '取消'}
              </button>
              <button
                className="px-3 py-1.5 text-xs bg-[#00c9a7] text-[#080d12] rounded hover:bg-[#00a98f]"
                onClick={handleCreateProject}
              >
                {t('common.create') || '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <ProjectContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          projectId={contextMenu.projectId!}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
};

export default ERSidebar;
