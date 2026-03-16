import React, { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { GitBranch, Search, Loader2, RefreshCw } from 'lucide-react';

interface GraphNode {
  id: string;
  node_type: string;
  connection_id: number;
  name: string;
  display_name?: string;
  metadata?: any;
}

interface GraphExplorerProps {
  connectionId: number | null;
}

const nodeTypeBadge = (nodeType: string) => {
  switch (nodeType) {
    case 'table':
      return 'bg-[#0d2a3d] text-[#38bdf8] border border-[#38bdf8]/30';
    case 'column':
      return 'bg-[#1e2d42] text-[#94a3b8] border border-[#253347]';
    case 'index':
      return 'bg-[#2d1e42] text-[#c084fc] border border-[#c084fc]/30';
    default:
      return 'bg-[#1e2d42] text-[#7a9bb8] border border-[#253347]';
  }
};

export const GraphExplorer: React.FC<GraphExplorerProps> = ({ connectionId }) => {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [keyword, setKeyword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isBuilding, setIsBuilding] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadNodes = useCallback(async (kw: string) => {
    if (connectionId === null) return;
    setIsLoading(true);
    try {
      if (kw.trim()) {
        const result = await invoke<GraphNode[]>('search_graph', {
          connectionId,
          keyword: kw.trim(),
        });
        setNodes(result);
      } else {
        const result = await invoke<GraphNode[]>('get_graph_nodes', {
          connectionId,
        });
        setNodes(result);
      }
    } catch (err) {
      console.warn('[GraphExplorer] load nodes error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    if (connectionId !== null) {
      loadNodes('');
    }
  }, [connectionId, loadNodes]);

  const handleKeywordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setKeyword(val);
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }
    searchTimerRef.current = setTimeout(() => {
      loadNodes(val);
    }, 300);
  };

  const handleBuildGraph = async () => {
    if (connectionId === null) return;
    setIsBuilding(true);
    try {
      await invoke('build_schema_graph', { connectionId });
      await loadNodes(keyword);
    } catch (err) {
      console.warn('[GraphExplorer] build_schema_graph error:', err);
    } finally {
      setIsBuilding(false);
    }
  };

  if (connectionId === null) {
    return (
      <div className="flex-1 flex flex-col min-w-0 bg-[#111922] items-center justify-center">
        <GitBranch size={40} className="text-[#253347] mb-3" />
        <p className="text-[#7a9bb8] text-sm">请先选择数据库连接</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#111922] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e2d42] flex-shrink-0">
        <div className="flex items-center gap-2">
          <GitBranch size={18} className="text-[#00c9a7]" />
          <h2 className="text-white font-semibold text-base">知识图谱</h2>
        </div>
        <button
          onClick={handleBuildGraph}
          disabled={isBuilding}
          className="flex items-center gap-1.5 text-xs text-[#7a9bb8] hover:text-[#c8daea] transition-colors px-3 py-1.5 bg-[#1a2639] hover:bg-[#253347] rounded border border-[#253347] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isBuilding
            ? <Loader2 size={13} className="animate-spin" />
            : <RefreshCw size={13} />
          }
          构建图谱
        </button>
      </div>

      {/* Search */}
      <div className="px-4 py-3 border-b border-[#1e2d42] flex-shrink-0">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#7a9bb8] pointer-events-none" />
          <input
            type="text"
            value={keyword}
            onChange={handleKeywordChange}
            placeholder="搜索节点..."
            className="w-full pl-8 pr-3 py-2 text-sm bg-[#0d1117] border border-[#1e2d42] rounded text-[#c8daea] placeholder-[#3d5470] focus:outline-none focus:border-[#00c9a7]/50 transition-colors"
          />
        </div>
      </div>

      {/* Node List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 size={24} className="animate-spin text-[#7a9bb8]" />
          </div>
        ) : nodes.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-[#7a9bb8] text-sm">
            <GitBranch size={28} className="mb-2 text-[#253347]" />
            {keyword ? '未找到匹配节点' : '暂无图谱数据，请点击「构建图谱」'}
          </div>
        ) : (
          <div className="divide-y divide-[#1e2d42]">
            {nodes.map((node) => (
              <div
                key={node.id}
                className="flex items-center px-6 py-3 hover:bg-[#0d1117] transition-colors"
              >
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 mr-3 ${nodeTypeBadge(node.node_type)}`}>
                  {node.node_type}
                </span>
                <div className="flex-1 min-w-0">
                  <span className="text-[#c8daea] text-sm truncate block">{node.name}</span>
                  {node.display_name && node.display_name !== node.name && (
                    <span className="text-[#7a9bb8] text-xs truncate block">{node.display_name}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
