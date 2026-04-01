import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Workflow, RefreshCw, Plus, Search, X } from 'lucide-react';
import { Tooltip } from '../common/Tooltip';
import { SeaTunnelJobTree } from './SeaTunnelJobTree';
import { SeaTunnelConnectionModal } from './SeaTunnelConnectionModal';
import { useSeaTunnelStore } from '../../store/seaTunnelStore';
import { useQueryStore } from '../../store/queryStore';

export interface SeaTunnelSidebarProps {
  sidebarWidth: number;
  onResize: (e: React.MouseEvent) => void;
  hidden?: boolean;
}

export function SeaTunnelSidebar({ sidebarWidth, onResize, hidden }: SeaTunnelSidebarProps) {
  const { t } = useTranslation();
  const { init } = useSeaTunnelStore();
  const openSeaTunnelJobTab = useQueryStore(s => s.openSeaTunnelJobTab);
  const [searchQuery, setSearchQuery] = useState('');
  const [showConnectionModal, setShowConnectionModal] = useState(false);

  useEffect(() => {
    init();
  }, []);

  const handleOpenJob = (jobId: number, title: string, connectionId?: number) => {
    openSeaTunnelJobTab(jobId, title, connectionId);
  };

  return (
    <div
      className="flex flex-col bg-[var(--background-base)] border-r border-[var(--border-default)] flex-shrink-0 relative"
      style={{ width: sidebarWidth, display: hidden ? 'none' : undefined }}
    >
      {/* 拖拽调整宽度 */}
      <div
        className="absolute right-[-2px] top-0 bottom-0 w-1 cursor-col-resize hover:bg-[var(--accent)] z-20 transition-colors"
        onMouseDown={onResize}
      />

      {/* 标题栏 */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-[var(--border-default)] flex-shrink-0">
        <div className="flex items-center gap-2">
          <Workflow size={14} className="text-[var(--accent)]" />
          <span className="font-medium text-[var(--foreground-default)]">{t('seaTunnel.title')}</span>
        </div>
        <div className="flex items-center space-x-2 text-[var(--foreground-muted)]">
          <Tooltip content={t('seaTunnel.refresh')}>
            <RefreshCw
              size={16}
              className="cursor-pointer hover:text-[var(--foreground-default)] transition-colors"
              onClick={() => init()}
            />
          </Tooltip>
          <Tooltip content={t('seaTunnel.newConnection')}>
            <div
              className="flex items-center gap-0.5 cursor-pointer hover:text-[var(--foreground-default)] transition-colors"
              onClick={() => setShowConnectionModal(true)}
            >
              <Plus size={14} />
              <span className="text-xs">{t('seaTunnel.connection')}</span>
            </div>
          </Tooltip>
        </div>
      </div>

      {/* 搜索框 */}
      <div className="p-2 border-b border-[var(--border-default)]">
        <div className="flex items-center bg-[var(--background-elevated)] border border-[var(--border-strong)] rounded px-2 py-1 focus-within:border-[var(--accent-hover)] transition-colors">
          <Search size={14} className="text-[var(--foreground-muted)] mr-1 flex-shrink-0" />
          <input
            type="text"
            placeholder={t('seaTunnel.searchPlaceholder')}
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

      {/* Job 树 */}
      <SeaTunnelJobTree
        searchQuery={searchQuery}
        onOpenJob={handleOpenJob}
      />

      {/* 连接弹窗 */}
      {showConnectionModal && (
        <SeaTunnelConnectionModal
          mode="create"
          onClose={() => setShowConnectionModal(false)}
          onSave={() => init()}
        />
      )}

    </div>
  );
}
