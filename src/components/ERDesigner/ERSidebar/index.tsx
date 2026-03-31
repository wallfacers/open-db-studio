import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, FolderOpen, Plus, Database, TableProperties, Key, Hash, Link2, MoreVertical, ChevronRight, ChevronDown, X } from 'lucide-react';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import { useQueryStore } from '../../../store/queryStore';
import type { ErProject, ErTable, ErColumn } from '../../../types';
import { Tooltip } from '../../common/Tooltip';
import { DropdownSelect } from '../../common/DropdownSelect';
import { ProjectContextMenu } from './ProjectContextMenu';
import { TableContextMenu } from './TableContextMenu';

const SQL_TYPES = [
  { value: 'INT', label: 'INT' },
  { value: 'BIGINT', label: 'BIGINT' },
  { value: 'VARCHAR', label: 'VARCHAR' },
  { value: 'TEXT', label: 'TEXT' },
  { value: 'CHAR', label: 'CHAR' },
  { value: 'DATETIME', label: 'DATETIME' },
  { value: 'DATE', label: 'DATE' },
  { value: 'TIMESTAMP', label: 'TIMESTAMP' },
  { value: 'BOOLEAN', label: 'BOOLEAN' },
  { value: 'DECIMAL', label: 'DECIMAL' },
  { value: 'FLOAT', label: 'FLOAT' },
  { value: 'DOUBLE', label: 'DOUBLE' },
];

// ColumnRow 组件 - 字段行编辑 UI
interface ColumnRowProps {
  column: ErColumn;
  tableId: number;
}

const ColumnRow = ({ column, tableId }: ColumnRowProps) => {
  const { updateColumn, deleteColumn } = useErDesignerStore();
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(column.name);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // 外部更新时同步 editName（画布编辑 → 侧边栏同步）
  useEffect(() => {
    if (!isEditingName) {
      setEditName(column.name);
    }
  }, [column.name, isEditingName]);

  // 自动聚焦字段名输入框
  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, [isEditingName]);

  // 保存字段名
  const handleNameSave = () => {
    setIsEditingName(false);
    if (editName.trim() && editName !== column.name) {
      updateColumn(column.id, { name: editName.trim() });
    } else {
      setEditName(column.name);
    }
  };

  // 主键切换
  const handleTogglePrimaryKey = () => {
    updateColumn(column.id, { is_primary_key: !column.is_primary_key });
  };

  // 自动递增切换（仅主键可用）
  const handleToggleAutoIncrement = () => {
    if (!column.is_primary_key) return;
    updateColumn(column.id, { is_auto_increment: !column.is_auto_increment });
  };

  return (
    <div
      className="flex items-center py-1 group hover:bg-[#1a2639] cursor-default"
      style={{ paddingLeft: '44px' }}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
    >
      {/* 主键图标 */}
      <span title={column.is_primary_key ? '主键' : '点击设置为主键'}>
        <Key
          size={10}
          className={`mr-1 flex-shrink-0 cursor-pointer ${
            column.is_primary_key ? 'text-[#00c9a7]' : 'text-gray-500 hover:text-gray-300'
          }`}
          onClick={handleTogglePrimaryKey}
        />
      </span>

      {/* 自动递增图标（仅主键显示） */}
      {column.is_primary_key && (
        <span title={column.is_auto_increment ? '自动递增' : '点击设置自动递增'}>
          <Hash
            size={10}
            className={`mr-1 flex-shrink-0 cursor-pointer ${
              column.is_auto_increment ? 'text-[#00c9a7]' : 'text-gray-500 hover:text-gray-300'
            }`}
            onClick={handleToggleAutoIncrement}
          />
        </span>
      )}

      {/* 字段名 - 可编辑 */}
      {isEditingName ? (
        <input
          ref={nameInputRef}
          className="bg-[#151d28] text-[#b5cfe8] text-[13px] px-1 rounded outline-none border border-[#00c9a7] min-w-[40px]"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleNameSave}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleNameSave();
            if (e.key === 'Escape') {
              setEditName(column.name);
              setIsEditingName(false);
            }
          }}
          style={{ width: `${Math.max(editName.length * 7, 40)}px` }}
        />
      ) : (
        <span
          className="text-[13px] text-[#b5cfe8] truncate cursor-text hover:bg-[#253347] px-0.5 rounded"
          onDoubleClick={() => setIsEditingName(true)}
          title="双击编辑"
        >
          {column.name}
        </span>
      )}

      {/* 类型 */}
      <div className="ml-1 shrink-0">
        <DropdownSelect
          value={column.data_type}
          options={SQL_TYPES}
          onChange={(value) => updateColumn(column.id, { data_type: value })}
          plain
        />
      </div>

      {/* 删除按钮 - hover 显示 */}
      <span title="删除字段">
        <X
          size={12}
          className="ml-1 cursor-pointer text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 shrink-0"
          onClick={() => deleteColumn(column.id, tableId)}
        />
      </span>
    </div>
  );
};

interface ERSidebarProps {
  width: number;
  hidden?: boolean;
}

export const ERSidebar: React.FC<ERSidebarProps> = ({ width, hidden }: ERSidebarProps) => {
  const { t } = useTranslation();
  const [expandedProjects, setExpandedProjects] = useState<Set<number>>(new Set());
  const [expandedTables, setExpandedTables] = useState<Set<number>>(new Set());
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

  const toggleTable = (tableId: number) => {
    setExpandedTables(prev => {
      const next = new Set(prev);
      if (next.has(tableId)) {
        next.delete(tableId);
      } else {
        next.add(tableId);
      }
      return next;
    });
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
                            onClick={() => hasColumns && toggleTable(table.id)}
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
                              className={`mr-1.5 flex-shrink-0 ${
                                isTableExpanded ? 'text-[#00c9a7]' : 'text-[#7a9bb8]'
                              }`}
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
                          </div>

                          {/* Column Nodes */}
                          {isTableExpanded && getTableColumns(table.id).map(column => (
                            <ColumnRow
                              key={column.id}
                              column={column}
                              tableId={table.id}
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
