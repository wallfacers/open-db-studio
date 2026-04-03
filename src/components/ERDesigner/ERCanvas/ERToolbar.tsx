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
  RefreshCw,
  Link2,
} from 'lucide-react';
import { useErDesignerStore } from '../../../store/erDesignerStore';
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
}: ERToolbarProps) {
  const { t } = useTranslation();
  const {
    addTable,
    syncFromDatabase,
    exportJson,
    previewImport,
    executeImport,
    projects,
    activeProjectId,
  } = useErDesignerStore();

  const projectName = projects.find(p => p.id === projectId)?.name;

  const [isAutoLayouting, setIsAutoLayouting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
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
      const table = await addTable(name, pos);
      onTableAdded?.(table);
    } catch (e) {
      console.error('Failed to add table:', e);
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

  // 同步数据库
  const handleSync = async () => {
    setIsSyncing(true);
    try {
      await syncFromDatabase(projectId);
    } catch (e) {
      console.error('Sync failed:', e);
    } finally {
      setIsSyncing(false);
    }
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
    } catch (e) {
      console.error('Export JSON failed:', e);
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
      }
    } catch (e) {
      console.error('Import JSON failed:', e);
    }
  };

  const handleImportConfirm = async (resolutions: ConflictResolution[]) => {
    if (!importState) return;
    try {
      await executeImport(importState.json, importState.targetProjectId, resolutions);
    } catch (e) {
      console.error('Import execute failed:', e);
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
      <button
        onClick={handleAddTable}
        className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors"
        title={t('erDesigner.newTable')}
      >
        <Plus size={14} />
        <span>{t('erDesigner.newTable')}</span>
      </button>

      <button
        onClick={handleAutoLayout}
        disabled={isAutoLayouting}
        className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title={t('erDesigner.autoLayout')}
      >
        <LayoutGrid size={14} />
        <span>{isAutoLayouting ? t('erDesigner.layouting') : t('erDesigner.autoLayout')}</span>
      </button>

      <button
        onClick={handleImportTables}
        disabled={!hasConnection}
        className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        title={hasConnection ? t('erDesigner.importTables') : t('erDesigner.noConnectionTip')}
      >
        <Database size={14} />
        <span>{t('erDesigner.importTables')}</span>
      </button>

      <button
        onClick={onOpenBind}
        className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors"
        title={t('erDesigner.bindConnection')}
      >
        <Link2 size={14} />
        <span>{t('erDesigner.bindConnection')}</span>
      </button>

      {/* 分隔符 */}
      <div className="w-px h-4 bg-border-strong mx-2" />

      {/* DDL/Diff/Sync 组 */}
      <button
        onClick={handleDDL}
        className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors"
        title={t('erDesigner.ddlPreview')}
      >
        <FileCode size={14} />
        <span>DDL</span>
      </button>

      <button
        onClick={handleDiff}
        disabled={!hasConnection}
        className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        title={hasConnection ? t('erDesigner.diffCheck') : t('erDesigner.noConnectionTip')}
      >
        <GitCompare size={14} />
        <span>Diff</span>
      </button>

      <button
        onClick={handleSync}
        disabled={!hasConnection || isSyncing}
        className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        title={hasConnection ? t('erDesigner.syncDB') : t('erDesigner.noConnectionTip')}
      >
        <RefreshCw size={14} className={isSyncing ? 'animate-spin' : ''} />
        <span>{isSyncing ? t('erDesigner.syncing') : t('erDesigner.sync')}</span>
      </button>

      {/* 分隔符 */}
      <div className="w-px h-4 bg-border-strong mx-2" />

      {/* 导入/导出组 */}
      <button
        onClick={handleExportJson}
        className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors"
        title={t('erDesigner.exportJson')}
      >
        <Download size={14} />
        <span>{t('erDesigner.exportJson')}</span>
      </button>

      <button
        onClick={handleImportJson}
        className="px-2.5 py-1.5 text-xs text-foreground-default hover:bg-background-hover rounded flex items-center gap-1.5 transition-colors"
        title={t('erDesigner.importJson')}
      >
        <Upload size={14} />
        <span>{t('erDesigner.importJson')}</span>
      </button>

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
