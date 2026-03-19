import React, { useEffect, useState } from 'react';
import { Workflow, RefreshCw, Plus, FolderPlus, Search, X } from 'lucide-react';
import { Tooltip } from '../common/Tooltip';
import { SeaTunnelJobTree } from './SeaTunnelJobTree';
import { SeaTunnelConnectionModal } from './SeaTunnelConnectionModal';
import { CategoryEditModal } from './CategoryEditModal';
import { useSeaTunnelStore } from '../../store/seaTunnelStore';

export interface SeaTunnelSidebarProps {
  sidebarWidth: number;
  onResize: (e: React.MouseEvent) => void;
  hidden?: boolean;
}

export function SeaTunnelSidebar({ sidebarWidth, onResize, hidden }: SeaTunnelSidebarProps) {
  const { init, createCategory } = useSeaTunnelStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [showConnectionModal, setShowConnectionModal] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);

  useEffect(() => {
    init();
  }, []);

  const handleOpenJob = (jobId: number, title: string, connectionId?: number) => {
    // TODO: 通知父组件打开 SeaTunnelJobTab
    console.log('open job', jobId, title, connectionId);
  };

  return (
    <div
      className="flex flex-col bg-[#0d1117] border-r border-[#1e2d42] flex-shrink-0 relative"
      style={{ width: sidebarWidth, display: hidden ? 'none' : undefined }}
    >
      {/* 拖拽调整宽度 */}
      <div
        className="absolute right-[-2px] top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#00c9a7] z-20 transition-colors"
        onMouseDown={onResize}
      />

      {/* 标题栏 */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-[#1e2d42] flex-shrink-0">
        <div className="flex items-center gap-2">
          <Workflow size={14} className="text-[#00c9a7]" />
          <span className="font-medium text-[#c8daea]">迁移中心</span>
        </div>
        <div className="flex items-center space-x-2 text-[#7a9bb8]">
          <Tooltip content="刷新">
            <RefreshCw
              size={16}
              className="cursor-pointer hover:text-[#c8daea] transition-colors"
              onClick={() => init()}
            />
          </Tooltip>
          <Tooltip content="新建连接">
            <div
              className="flex items-center gap-0.5 cursor-pointer hover:text-[#c8daea] transition-colors"
              onClick={() => setShowConnectionModal(true)}
            >
              <Plus size={14} />
              <span className="text-xs">连接</span>
            </div>
          </Tooltip>
          <Tooltip content="新建分类">
            <div
              className="flex items-center gap-0.5 cursor-pointer hover:text-[#c8daea] transition-colors"
              onClick={() => setShowCategoryModal(true)}
            >
              <FolderPlus size={14} />
            </div>
          </Tooltip>
        </div>
      </div>

      {/* 搜索框 */}
      <div className="p-2 border-b border-[#1e2d42]">
        <div className="flex items-center bg-[#151d28] border border-[#2a3f5a] rounded px-2 py-1 focus-within:border-[#00a98f] transition-colors">
          <Search size={14} className="text-[#7a9bb8] mr-1 flex-shrink-0" />
          <input
            type="text"
            placeholder="搜索 Job / 分类..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="bg-transparent border-none outline-none text-[#c8daea] w-full text-xs placeholder-[#7a9bb8]"
          />
          {searchQuery && (
            <button
              className="text-[#7a9bb8] ml-1 hover:text-[#c8daea] flex-shrink-0"
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

      {/* 新建分类弹窗 */}
      {showCategoryModal && (
        <CategoryEditModal
          mode="create"
          onClose={() => setShowCategoryModal(false)}
          onSave={async (name) => {
            await createCategory(name);
          }}
        />
      )}
    </div>
  );
}
