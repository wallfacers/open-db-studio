import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, FolderOpen, Plus, Database, TableProperties, Link2, MoreVertical, ChevronRight, ChevronDown, Grid3x3, Edit3 } from 'lucide-react';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import { useQueryStore } from '../../../store/queryStore';
import type { ErProject, ErTable, ErColumn } from '../../../types';
import { Tooltip } from '../../common/Tooltip';
import { ProjectContextMenu } from './ProjectContextMenu';
import { TableContextMenu } from './TableContextMenu';
import ColumnPropertyEditor from '../shared/ColumnPropertyEditor';
import type { DialectName } from '../shared/dataTypes';

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

  const sidebarRef = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(450);

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
    boundDialect,
    openDrawer,
    updateColumn,
    deleteColumn,
  } = useErDesignerStore();

  const { openERDesignTab } = useQueryStore();

  useEffect(() => {
    if (!sidebarRef.current) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setSidebarWidth(entry.contentRect.width);
      }
    });
    observer.observe(sidebarRef.current);
    return () => observer.disconnect();
  }, []);

  const visibleColumns = {
    comment: sidebarWidth >= 450,
    defaultValue: sidebarWidth >= 380,
    unique: sidebarWidth >= 300,
  };

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
      className="flex-shrink-0 bg-[#0d1117] border-r border-[#1e2d42] flex flex-col h-full"
      onClick={closeContextMenu}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-10 border-b border-[#1e2d42] bg-[#080d12]">
        <div className="flex items-center gap-2">
          <Grid3x3 size={14} className="text-[#00c9a7]" />
          <span className="font-medium text-[#c8daea]">
            {t('erDesigner.title') || 'ER 设计器'}
          </span>
        </div>
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
                className={`flex items-center py-1 px-2 cursor-pointer transition-colors group ${
                  activeProjectId === project.id ? 'bg-[#1e2d42]' : 'hover:bg-[#1a2639]'
                }`}
                onClick={() => handleProjectClick(project)}
                onDoubleClick={() => handleProjectDoubleClick(project)}
                onContextMenu={(e) => handleContextMenu(e, 'project', { projectId: project.id })}
              >
                <div className="w-4 h-4 mr-1 flex items-center justify-center text-[#7a9bb8] flex-shrink-0">
                  {expandedProjects.has(project.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </div>
                {expandedProjects.has(project.id) ? (
                  <FolderOpen size={14} className="mr-1.5 text-[#00c9a7] flex-shrink-0" />
                ) : (
                  <Folder size={14} className="mr-1.5 text-[#7a9bb8] flex-shrink-0" />
                )}
                <span className="text-[13px] text-[#b5cfe8] flex-1 truncate">{project.name}</span>
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
                  tables
                    .filter(t => t.project_id === project.id)
                    .map(table => {
                      const isTableExpanded = expandedTables.has(table.id);
                      const hasColumns = getTableColumns(table.id).length > 0;
                      return (
                        <div key={table.id}>
                          {/* Table Node */}
                          <div
                            className="flex items-center py-1 px-2 cursor-pointer transition-colors group hover:bg-[#1a2639]"
                            style={{ paddingLeft: '32px' }}
                            onClick={() => hasColumns && toggleTableExpand(table.id)}
                            onDoubleClick={() => handleTableDoubleClick(project.id, table.name)}
                            onContextMenu={(e) => handleContextMenu(e, 'table', { projectId: project.id, tableId: table.id })}
                          >
                            <div className="w-4 h-4 mr-1 flex items-center justify-center text-[#7a9bb8] flex-shrink-0">
                              {hasColumns ? (
                                isTableExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
                              ) : null}
                            </div>
                            <TableProperties
                              size={14}
                              className={`mr-1.5 flex-shrink-0 ${table.color ? '' : (isTableExpanded ? 'text-[#00c9a7]' : 'text-[#7a9bb8]')}`}
                              style={table.color ? { color: table.color } : undefined}
                            />
                            <span className="text-[13px] text-[#b5cfe8] flex-1 truncate">{table.name}</span>
                            <span className="text-[11px] text-[#7a9bb8] mr-1">
                              {getTableColumns(table.id).length}
                            </span>
                            {getRelationCount(table.id) > 0 && (
                              <Tooltip content={`${getRelationCount(table.id)} ${t('erDesigner.relations') || '个关系'}`}>
                                <Link2 size={10} className="text-[#a855f7] mr-1" />
                              </Tooltip>
                            )}
                            <button
                              className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-[#00c9a7] transition-all"
                              onClick={(e) => { e.stopPropagation(); openDrawer(table.id); }}
                              title="在属性面板中编辑"
                            >
                              <Edit3 size={12} />
                            </button>
                          </div>

                          {/* Column Header */}
                          {isTableExpanded && (
                            <div className="flex items-center gap-1.5 px-2 h-[20px] text-[11px] text-[#4a6480] select-none" style={{ paddingLeft: '60px' }}>
                              <span className="w-[40px] shrink-0"></span>
                              <span className="flex-1 min-w-0">列名</span>
                              <span className="w-[130px] shrink-0">类型</span>
                              <span className="w-[28px] shrink-0 text-center">NN</span>
                              {visibleColumns.unique && <span className="w-[28px] shrink-0 text-center">UQ</span>}   
                              {visibleColumns.defaultValue && <span className="w-[80px] shrink-0">默认值</span>}     
                              {visibleColumns.comment && <span className="w-[60px] shrink-0 text-center">注释</span>}
                              <span className="w-[24px] shrink-0"></span>
                            </div>
                          )}
                          {/* Column Rows */}
                          {isTableExpanded && getTableColumns(table.id).map(column => (
                            <ColumnPropertyEditor
                              key={column.id}
                              column={column}
                              tableId={table.id}
                              dialect={boundDialect as DialectName | null}
                              mode="compact"
                              onUpdate={updateColumn}
                              onDelete={deleteColumn}
                              onOpenDrawer={openDrawer}
                              visibleColumns={visibleColumns}
                            />
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
