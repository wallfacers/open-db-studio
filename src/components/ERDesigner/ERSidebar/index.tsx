import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, FolderOpen, Plus, Database, TableProperties, Link2, MoreVertical, ChevronRight, ChevronDown, Grid3x3, Edit3, Key, Search, X } from 'lucide-react';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import { useQueryStore } from '../../../store/queryStore';
import type { ErProject, ErTable, ErColumn } from '../../../types';
import { Tooltip } from '../../common/Tooltip';
import { ProjectContextMenu } from './ProjectContextMenu';
import { TableContextMenu } from './TableContextMenu';
import { formatTypeDisplay } from '../shared/dataTypes';

interface ERSidebarProps {
  width: number;
  hidden?: boolean;
}

export const ERSidebar: React.FC<ERSidebarProps> = ({ width, hidden }: ERSidebarProps) => {
  const { t } = useTranslation();
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
  const [searchQuery, setSearchQuery] = useState('');

  const sidebarRef = useRef<HTMLDivElement>(null);

  const {
    projects,
    loadProjects,
    createProject,
    activeProjectId,
    tables,
    columns,
    relations,
    expandedProjects,
    expandedTables,
    toggleProjectExpand,
    toggleTableExpand,
    restoreExpandedState,
    openDrawer,
  } = useErDesignerStore();

  const { openERDesignTab } = useQueryStore();

  useEffect(() => {
    loadProjects();
    restoreExpandedState();
  }, [loadProjects, restoreExpandedState]);

  const handleProjectClick = (project: ErProject) => {
    toggleProjectExpand(project.id);
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
      ref={sidebarRef}
      style={{ width }}
      className="flex-shrink-0 bg-[var(--background-base)] border-r border-[var(--border-default)] flex flex-col h-full"
      onClick={closeContextMenu}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-10 border-b border-[var(--border-default)]">
        <div className="flex items-center gap-2">
          <Grid3x3 size={14} className="text-[var(--accent)]" />
          <span className="font-medium text-[var(--foreground-default)]">
            {t('erDesigner.title') || 'ER 设计器'}
          </span>
        </div>
        <Tooltip content={t('erDesigner.newProject') || '新建项目'}>
          <button
            className="p-1 rounded hover:bg-[var(--border-default)] text-[var(--foreground-muted)] hover:text-[var(--accent)]"
            onClick={() => setShowCreateDialog(true)}
          >
            <Plus size={14} />
          </button>
        </Tooltip>
      </div>

      {/* 搜索框 */}
      <div className="h-10 flex items-center px-2 border-b border-[var(--border-default)]">
        <div className="flex items-center bg-[var(--background-elevated)] border border-[var(--border-strong)] rounded px-2 py-1 flex-1 focus-within:border-[var(--accent-hover)] transition-colors">
          <Search size={14} className="text-[var(--foreground-muted)] mr-1 flex-shrink-0" />
          <input
            type="text"
            placeholder={t('erDesigner.searchPlaceholder') || '搜索项目或表...'}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="bg-transparent border-none outline-none text-[var(--foreground-default)] w-full text-xs placeholder-[var(--foreground-muted)]"
          />
          {searchQuery && (
            <button
              className="text-[var(--foreground-muted)] ml-1 hover:text-[var(--foreground-default)] flex-shrink-0"
              onClick={() => setSearchQuery('')}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Project List */}
      <div className="flex-1 overflow-y-auto py-1">
        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[var(--foreground-muted)] text-xs px-4 text-center">
            <Database size={32} className="mb-2 opacity-40" />
            <span>{t('erDesigner.noProjects') || '暂无 ER 项目'}</span>
            <span className="text-[10px] opacity-60 mt-1">{t('erDesigner.clickPlus') || '点击 + 创建新项目'}</span>
          </div>
        ) : (
          projects.filter(project => {
            if (!searchQuery.trim()) return true;
            const q = searchQuery.trim().toLowerCase();
            if (project.name.toLowerCase().includes(q)) return true;
            const projectTables = tables.filter(t => t.project_id === project.id);
            return projectTables.some(t => t.name.toLowerCase().includes(q));
          }).map(project => (
            <div key={project.id} className="select-none">
              {/* Project Node */}
              <div
                className={`flex items-center py-1 px-2 cursor-pointer transition-colors group ${
                  activeProjectId === project.id ? 'bg-[var(--border-default)]' : 'hover:bg-[var(--background-hover)]'
                }`}
                onClick={() => handleProjectClick(project)}
                onDoubleClick={() => handleProjectDoubleClick(project)}
                onContextMenu={(e) => handleContextMenu(e, 'project', { projectId: project.id })}
              >
                <div className="w-4 h-4 mr-1 flex items-center justify-center text-[var(--foreground-muted)] flex-shrink-0">
                  {expandedProjects.has(project.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </div>
                {expandedProjects.has(project.id) ? (
                  <FolderOpen size={14} className="mr-1.5 text-[var(--accent)] flex-shrink-0" />
                ) : (
                  <Folder size={14} className="mr-1.5 text-[var(--foreground-muted)] flex-shrink-0" />
                )}
                <span className="text-[13px] text-[var(--foreground)] flex-1 truncate">{project.name}</span>
                {project.connection_id && (
                  <Tooltip content={t('erDesigner.connectionBound') || '已绑定连接'}>
                    <Link2 size={10} className="mr-1 text-[var(--accent)]" />
                  </Tooltip>
                )}
                <button
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--border-strong)] text-[var(--foreground-muted)]"
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
                  tables
                    .filter(t => t.project_id === project.id)
                    .map(table => {
                      const isTableExpanded = expandedTables.has(table.id);
                      const hasColumns = getTableColumns(table.id).length > 0;
                      return (
                        <div key={table.id}>
                          {/* Table Node */}
                          <div
                            className="flex items-center py-1 px-2 cursor-pointer transition-colors group hover:bg-[var(--background-hover)]"
                            style={{ paddingLeft: '32px' }}
                            onClick={() => hasColumns && toggleTableExpand(table.id)}
                            onDoubleClick={() => handleTableDoubleClick(project.id, table.name)}
                            onContextMenu={(e) => handleContextMenu(e, 'table', { projectId: project.id, tableId: table.id })}
                          >
                            <div className="w-4 h-4 mr-1 flex items-center justify-center text-[var(--foreground-muted)] flex-shrink-0">
                              {hasColumns ? (
                                isTableExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
                              ) : null}
                            </div>
                            <TableProperties
                              size={14}
                              className={`mr-1.5 flex-shrink-0 ${table.color ? '' : (isTableExpanded ? 'text-[var(--accent)]' : 'text-[var(--foreground-muted)]')}`}
                              style={table.color ? { color: table.color } : undefined}
                            />
                            <span className="text-[13px] text-[var(--foreground)] flex-1 truncate">{table.name}</span>
                            <span className="text-[11px] text-[var(--foreground-muted)] mr-1">
                              {getTableColumns(table.id).length}
                            </span>
                            {getRelationCount(table.id) > 0 && (
                              <Tooltip content={`${getRelationCount(table.id)} ${t('erDesigner.relations') || '个关系'}`}>
                                <Link2 size={10} className="text-[var(--node-alias)] mr-1" />
                              </Tooltip>
                            )}
                            <button
                              className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-[var(--accent)] transition-all"
                              onClick={(e) => { e.stopPropagation(); openDrawer(table.id); }}
                              title="在属性面板中编辑"
                            >
                              <Edit3 size={12} />
                            </button>
                          </div>

                          {/* Column Rows */}
                          {isTableExpanded && getTableColumns(table.id).map(column => (
                            <div
                              key={column.id}
                              className="flex items-center gap-1.5 py-0.5 px-2 h-[26px] hover:bg-[var(--background-hover)] transition-colors text-[13px] text-[var(--foreground)] cursor-default"
                              style={{ paddingLeft: '56px' }}
                              onDoubleClick={() => openDrawer(table.id, column.id)}
                            >
                              <div className="w-[14px] shrink-0 flex items-center justify-center">
                                {column.is_primary_key && (
                                  <Key size={12} className="text-[var(--key-primary)]" />
                                )}
                              </div>
                              <span className="truncate">{column.name}</span>
                              <span className="ml-auto shrink-0 text-[11px] text-[var(--foreground-subtle)]">{formatTypeDisplay(column)}</span>
                            </div>
                          ))}
                        </div>
                      );
                    })
              )}
            </div>
          ))
        )}
      </div>

      {/* Create Project Dialog */}
      {showCreateDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowCreateDialog(false)}>
          <div className="bg-[var(--background-elevated)] border border-[var(--border-strong)] rounded-lg p-4 w-72" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm text-[var(--foreground-default)] mb-3">{t('erDesigner.newProject') || '新建 ER 项目'}</h3>
            <input
              type="text"
              className="w-full px-3 py-2 bg-[var(--background-hover)] border border-[var(--border-strong)] rounded text-xs text-[var(--foreground-default)] placeholder-[var(--foreground-subtle)] focus:outline-none focus:border-[var(--accent)]"
              placeholder={t('erDesigner.projectName') || '项目名称'}
              value={newProjectName}
              onChange={e => setNewProjectName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateProject()}
              autoFocus
            />
            <div className="flex justify-end mt-3 gap-2">
              <button
                className="px-3 py-1.5 text-xs text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] rounded"
                onClick={() => setShowCreateDialog(false)}
              >
                {t('common.cancel') || '取消'}
              </button>
              <button
                className="px-3 py-1.5 text-xs bg-[var(--accent)] text-[var(--background-void)] rounded hover:bg-[var(--accent-hover)]"
                onClick={handleCreateProject}
              >
                {t('common.create') || '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu?.type === 'project' && contextMenu.projectId && (
        <ProjectContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          projectId={contextMenu.projectId}
          onClose={closeContextMenu}
        />
      )}
      {contextMenu?.type === 'table' && contextMenu.projectId && contextMenu.tableId && (
        <TableContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          projectId={contextMenu.projectId}
          tableId={contextMenu.tableId}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
};

export default ERSidebar;
