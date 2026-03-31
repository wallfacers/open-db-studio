import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  LayoutGrid,
  Download,
  Upload,
  FileCode,
  GitCompare,
  RefreshCw,
  Link2,
} from 'lucide-react';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import type { ErTable } from '../../../types';
import { open } from '@tauri-apps/plugin-dialog';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { invoke } from '@tauri-apps/api/core';
import type { Node } from '@xyflow/react';
import { layoutNodesWithDagre } from '../utils/dagreLayout';

export interface ERToolbarProps {
  projectId: number;
  onOpenDDL: () => void;
  onOpenDiff: () => void;
  onOpenImport: () => void;
  setNodes?: (nodes: Node[]) => void;
  tables?: Array<{ id: number; position_x: number; position_y: number }>;
  nodes?: Node[];
  onTableAdded?: (table: ErTable) => void;
  onOpenBind?: () => void;
}

export default function ERToolbar({
  projectId,
  onOpenDDL,
  onOpenDiff,
  onOpenImport,
  setNodes,
  tables = [],
  nodes = [],
  onTableAdded,
  onOpenBind,
}: ERToolbarProps) {
  const { t } = useTranslation();
  const {
    addTable,
    syncFromDatabase,
    exportJson,
    importJson,
  } = useErDesignerStore();

  const [isAutoLayouting, setIsAutoLayouting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  // 新建表
  const handleAddTable = async () => {
    try {
      const pos = { x: Math.random() * 300 + 100, y: Math.random() * 300 + 100 };
      const table = await addTable('new_table', pos);
      onTableAdded?.(table);
    } catch (e) {
      console.error('Failed to add table:', e);
    }
  };

  // 自动布局 - 使用 dagre
  const handleAutoLayout = () => {
    if (!setNodes || nodes.length === 0) return;

    setIsAutoLayouting(true);

    try {
      const layoutedNodes = layoutNodesWithDagre(nodes);
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
      await writeText(json);
      console.log('JSON copied to clipboard');
    } catch (e) {
      console.error('Export JSON failed:', e);
    }
  };

  // 导入 JSON
  const handleImportJson = async () => {
    try {
      const openPath = await open({
        multiple: false,
        filters: [
          {
            name: 'JSON',
            extensions: ['json'],
          },
        ],
      });

      if (openPath && typeof openPath === 'string') {
        const json = await invoke<string>('read_text_file', { path: openPath });
        await importJson(json);
      }
    } catch (e) {
      console.error('Import JSON failed:', e);
    }
  };

  return (
    <div className="flex items-center gap-2 h-10 bg-[#0d1117] border-b border-[#1e2d42] px-4 flex-shrink-0">
      {/* 表操作组 */}
      <button
        onClick={handleAddTable}
        className="px-2.5 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] rounded flex items-center gap-1.5 transition-colors"
        title={t('erDesigner.newTable')}
      >
        <Plus size={14} />
        <span>{t('erDesigner.newTable')}</span>
      </button>

      <button
        onClick={handleAutoLayout}
        disabled={isAutoLayouting}
        className="px-2.5 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] rounded flex items-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title={t('erDesigner.autoLayout')}
      >
        <LayoutGrid size={14} />
        <span>{isAutoLayouting ? t('erDesigner.layouting') : t('erDesigner.autoLayout')}</span>
      </button>

      <button
        onClick={handleImportTables}
        className="px-2.5 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] rounded flex items-center gap-1.5 transition-colors"
        title={t('erDesigner.importTables')}
      >
        <Download size={14} />
        <span>{t('erDesigner.importTables')}</span>
      </button>

      <button
        onClick={onOpenBind}
        className="px-2.5 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] rounded flex items-center gap-1.5 transition-colors"
        title={t('erDesigner.bindConnection')}
      >
        <Link2 size={14} />
        <span>{t('erDesigner.bindConnection')}</span>
      </button>

      {/* 分隔符 */}
      <div className="w-px h-4 bg-[#253347] mx-2" />

      {/* DDL/Diff/Sync 组 */}
      <button
        onClick={handleDDL}
        className="px-2.5 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] rounded flex items-center gap-1.5 transition-colors"
        title={t('erDesigner.ddlPreview')}
      >
        <FileCode size={14} />
        <span>DDL</span>
      </button>

      <button
        onClick={handleDiff}
        className="px-2.5 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] rounded flex items-center gap-1.5 transition-colors"
        title={t('erDesigner.diffCheck')}
      >
        <GitCompare size={14} />
        <span>Diff</span>
      </button>

      <button
        onClick={handleSync}
        disabled={isSyncing}
        className="px-2.5 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] rounded flex items-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title={t('erDesigner.syncDB')}
      >
        <RefreshCw size={14} className={isSyncing ? 'animate-spin' : ''} />
        <span>{isSyncing ? t('erDesigner.syncing') : t('erDesigner.sync')}</span>
      </button>

      {/* 分隔符 */}
      <div className="w-px h-4 bg-[#253347] mx-2" />

      {/* 导入/导出组 */}
      <button
        onClick={handleExportJson}
        className="px-2.5 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] rounded flex items-center gap-1.5 transition-colors"
        title={t('erDesigner.exportJson')}
      >
        <Upload size={14} />
        <span>{t('erDesigner.exportJson')}</span>
      </button>

      <button
        onClick={handleImportJson}
        className="px-2.5 py-1.5 text-xs text-[#c8daea] hover:bg-[#1a2639] rounded flex items-center gap-1.5 transition-colors"
        title={t('erDesigner.importJson')}
      >
        <Download size={14} />
        <span>{t('erDesigner.importJson')}</span>
      </button>
    </div>
  );
}
