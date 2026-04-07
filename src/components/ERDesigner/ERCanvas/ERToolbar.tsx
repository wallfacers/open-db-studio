import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  LayoutGrid,
  Database,
  Download,
  Upload,
  FileCode,
  GitCompare,
  Link2,
  Unlink,
  Settings,
} from 'lucide-react';
import { Tooltip } from '../../common/Tooltip';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import { useToastStore } from '../../../store/toastStore';
import { useConfirmStore } from '../../../store/confirmStore';
import ImportConflictDialog from '../ImportConflictDialog';
import type { ErTable, ConflictResolution, ImportPreview } from '../../../types';
import { open, save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import type { Node, Edge } from '@xyflow/react';
import { layoutNodesWithDagre } from '../utils/dagreLayout';

export interface ERToolbarProps {
  projectId: number;
  onOpenDDL: () => void;
  onOpenDiff: () => void;
  onOpenImport: () => void;
  setNodes?: (nodes: Node[]) => void;
  tables?: Array<{ id: number; position_x: number; position_y: number }>;
  nodes?: Node[];
  edges?: Edge[];
  onTableAdded?: (table: ErTable) => void;
  onOpenBind?: () => void;
  onAutoLayout?: () => void;
  hasConnection?: boolean;
  databaseName?: string | null;
  onOpenSettings?: () => void;
}

export default function ERToolbar({
  projectId,
  onOpenDDL,
  onOpenDiff,
  onOpenImport,
  setNodes,
  tables = [],
  nodes = [],
  edges = [],
  onTableAdded,
  onOpenBind,
  onAutoLayout,
  hasConnection = false,
  databaseName,
  onOpenSettings,
}: ERToolbarProps) {
  const { t } = useTranslation();
  const showToast = useToastStore(s => s.show);
  const showError = useToastStore(s => s.showError);
  const {
    addTable,
    exportJson,
    previewImport,
    executeImport,
    projects,
    unbindConnection,
  } = useErDesignerStore();

  const projectName = projects.find(p => p.id === projectId)?.name;

  const [isAutoLayouting, setIsAutoLayouting] = useState(false);
  const [importState, setImportState] = useState<{
    json: string;
    preview: ImportPreview;
    targetProjectId?: number;
  } | null>(null);

  // 新建表
  const handleAddTable = async () => {
    try {
      const existing = new Set(tables.map(t => (t as any).name));
      let name = 'new_table';
      let i = 1;
      while (existing.has(name)) {
        name = `new_table_${++i}`;
      }
      const pos = { x: Math.random() * 300 + 100, y: Math.random() * 300 + 100 };
      const table = await addTable(projectId, name, pos);
      onTableAdded?.(table);
    } catch (e) {
      console.error('Failed to add table:', e);
      showError(`创建表失败: ${e}`);
    }
  };

  // 自动布局 - 使用 dagre
  const handleAutoLayout = () => {
    if (onAutoLayout) {
      onAutoLayout();
      return;
    }

    if (!setNodes || nodes.length === 0) return;

    setIsAutoLayouting(true);

    try {
      const layoutedNodes = layoutNodesWithDagre(nodes, edges);
      setNodes(layoutedNodes);
    } catch (e) {
      console.error('Auto layout failed:', e);
    } finally {
      setIsAutoLayouting(false);
    }
  };

  // 导入表（占位）
  const handleImportTables = () => {
    console.log('Import tables clicked');
    onOpenImport();
  };

  // DDL 预览
  const handleDDL = () => {
    onOpenDDL();
  };

  // Diff
  const handleDiff = () => {
    onOpenDiff();
  };

  // 导出 JSON
  const handleExportJson = async () => {
    try {
      const json = await exportJson(projectId);
      const defaultFileName = projectName ? `${projectName}.json` : 'er-project.json';
      const path = await save({
        defaultPath: defaultFileName,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!path) return;
      await invoke('write_text_file', { path, content: json });
      showToast('导出成功', 'success');
    } catch (e) {
      console.error('Export JSON failed:', e);
      showError(`导出失败: ${e}`);
    }
  };

  // 导入 JSON 到当前项目
  const handleImportJson = async () => {
    try {
      const openPath = await open({
        multiple: false,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!openPath || typeof openPath !== 'string') return;

      const json = await invoke<string>('read_text_file', { path: openPath });

      const preview = await previewImport(json, projectId);

      if (preview.conflict_tables.length > 0) {
        setImportState({ json, preview, targetProjectId: projectId });
      } else {
        await executeImport(json, projectId, []);
        showToast('导入成功', 'success');
      }
    } catch (e) {
      console.error('Import JSON failed:', e);
      showError(`导入失败: ${e}`);
    }
  };

  const handleImportConfirm = async (resolutions: ConflictResolution[]) => {
    if (!importState) return;
    try {
      await executeImport(importState.json, importState.targetProjectId, resolutions);
      showToast('导入成功', 'success');
    } catch (e) {
      console.error('Import execute failed:', e);
      showError(`导入失败: ${e}`);
    } finally {
      setImportState(null);
    }
  };

  const handleImportCancel = () => {
    setImportState(null);
  };

  return (
    <div className="flex items-center gap-2 h-8 bg-background-base border-b border-border-default px-4 flex-shrink-0 overflow-x-auto">
      {/* 表操作组 */}
      <Tooltip content={t('erDesigner.newTable')} className="flex items-center">
        <button
          onClick={handleAddTable}
          className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors"
        >
          <Plus size={14} />
          <span>{t('erDesigner.newTable')}</span>
        </button>
      </Tooltip>

      <Tooltip content={t('erDesigner.autoLayout')} className="flex items-center">
        <button
          onClick={handleAutoLayout}
          disabled={isAutoLayouting}
          className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <LayoutGrid size={14} />
          <span>{isAutoLayouting ? t('erDesigner.layouting') : t('erDesigner.autoLayout')}</span>
        </button>
      </Tooltip>

      <Tooltip content={hasConnection ? t('erDesigner.importTables') : t('erDesigner.noConnectionTip')} className="flex items-center">
        <button
          onClick={handleImportTables}
          disabled={!hasConnection}
          className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        >
          <Database size={14} />
          <span>{t('erDesigner.importTables')}</span>
        </button>
      </Tooltip>

      {hasConnection && databaseName ? (
        <Tooltip content={t('erDesigner.unbindConnection')} className="flex items-center">
          <button
            onClick={async () => {
              const ok = await useConfirmStore.getState().confirm({
                title: t('erDesigner.unbindConnection'),
                message: t('erDesigner.confirmUnbind'),
                variant: 'danger',
              });
              if (ok) {
                await unbindConnection(projectId);
              }
            }}
            className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-danger-hover-bg rounded flex items-center gap-1.5 transition-colors group"
          >
            <Database size={14} />
            <span className="max-w-[120px] truncate">{databaseName}</span>
            <Unlink size={12} className="text-foreground-muted group-hover:text-error transition-colors" />
          </button>
        </Tooltip>
      ) : (
        <Tooltip content={t('erDesigner.bindConnection')} className="flex items-center">
          <button
            onClick={onOpenBind}
            className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors"
          >
            <Link2 size={14} />
            <span>{t('erDesigner.bindConnection')}</span>
          </button>
        </Tooltip>
      )}

      {/* 分隔符 */}
      <div className="w-px h-4 bg-border-strong mx-2" />

      {/* DDL/Diff 组 */}
      <Tooltip content={t('erDesigner.ddlPreview')} className="flex items-center">
        <button
          onClick={handleDDL}
          className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors"
        >
          <FileCode size={14} />
          <span>DDL</span>
        </button>
      </Tooltip>

      <Tooltip content={hasConnection ? t('erDesigner.diffCheck') : t('erDesigner.noConnectionTip')} className="flex items-center">
        <button
          onClick={handleDiff}
          disabled={!hasConnection}
          className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        >
          <GitCompare size={14} />
          <span>Diff</span>
        </button>
      </Tooltip>

      {/* 分隔符 */}
      <div className="w-px h-4 bg-border-strong mx-2" />

      {/* 导入/导出组 */}
      <Tooltip content={t('erDesigner.exportJson')} className="flex items-center">
        <button
          onClick={handleExportJson}
          className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors"
        >
          <Download size={14} />
          <span>{t('erDesigner.exportJson')}</span>
        </button>
      </Tooltip>

      <Tooltip content={t('erDesigner.importJson')} className="flex items-center">
        <button
          onClick={handleImportJson}
          className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors"
        >
          <Upload size={14} />
          <span>{t('erDesigner.importJson')}</span>
        </button>
      </Tooltip>

      {onOpenSettings && (
        <>
          <div className="w-px h-4 bg-border-strong mx-2" />
          <Tooltip content={t('erDesigner.projectSettings') || '项目设置'} className="flex items-center">
            <button
              type="button"
              onClick={onOpenSettings}
              className="p-1.5 rounded text-foreground-muted hover:text-foreground-default hover:bg-background-hover transition-colors"
            >
              <Settings size={15} />
            </button>
          </Tooltip>
        </>
      )}

      {importState && (
        <ImportConflictDialog
          open={true}
          conflictTables={importState.preview.conflict_tables}
          onConfirm={handleImportConfirm}
          onCancel={handleImportCancel}
        />
      )}
    </div>
  );
}
