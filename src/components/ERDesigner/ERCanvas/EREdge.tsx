import { useState, useRef, useEffect } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import { parseErEdgeNodeId } from '../../../utils/nodeId';

interface EREdgeProps extends EdgeProps {
  source: string;
  sourceHandle?: string;
  target: string;
  targetHandle?: string;
  data?: {
    relation_type?: string;
    source_type?: 'schema' | 'comment' | 'designer';
  };
}

const RELATION_TYPES = [
  { value: 'one_to_one', label: '1:1' },
  { value: 'one_to_many', label: '1:N' },
  { value: 'many_to_one', label: 'N:1' },
  { value: 'many_to_many', label: 'N:N' },
] as const;

const RELATION_LABEL_MAP: Record<string, string> = {
  one_to_one: '1:1',
  one_to_many: '1:N',
  many_to_one: 'N:1',
  many_to_many: 'N:N',
};

export default function EREdge({ id, sourceX, sourceY, targetX, targetY, data, style, selected }: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });

  const sourceType = data?.source_type || 'schema';
  const relationType = (data?.relation_type as string) || 'one_to_many';
  const displayLabel = RELATION_LABEL_MAP[relationType] || relationType;

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const updateRelation = useErDesignerStore(s => s.updateRelation);
  const deleteRelation = useErDesignerStore(s => s.deleteRelation);

  // Close menu when deselected
  useEffect(() => {
    if (!selected) setMenuOpen(false);
  }, [selected]);

  // Close menu on outside click (use capture phase to work inside ReactFlow)
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as HTMLElement)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [menuOpen]);

  const handleChangeType = (newType: string) => {
    setMenuOpen(false);
    if (newType === relationType) return;
    const relationId = parseErEdgeNodeId(id);
    if (relationId == null) return;
    updateRelation(relationId, { relation_type: newType });
  };

  const handleDelete = () => {
    setMenuOpen(false);
    const relationId = parseErEdgeNodeId(id);
    if (relationId == null) return;
    deleteRelation(relationId);
  };

  // 根据源类型设置基础颜色
  const getBaseColor = () => {
    switch (sourceType) {
      case 'comment': return '#f59e0b';
      case 'designer': return '#a855f7';
      default: return '#3794ff';
    }
  };

  const baseColor = getBaseColor();

  const getEdgeStyle = () => {
    const base: React.CSSProperties = {
      stroke: baseColor,
      strokeWidth: selected ? 2.5 : 2,
      strokeDasharray: sourceType === 'comment' ? '4 2' : sourceType === 'designer' ? '2 2' : undefined,
    };
    if (selected) {
      base.filter = 'drop-shadow(0 0 4px ' + baseColor + ')';
    }
    return base;
  };

  const edgeStyle = getEdgeStyle();

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...edgeStyle,
          ...style,
        }}
      />
      <EdgeLabelRenderer>
        <div
          ref={menuRef}
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="flex items-center gap-1"
        >
          {/* 关系类型标签 */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(prev => !prev); }}
            className={`px-2 py-0.5 rounded text-xs font-mono shadow-sm transition-colors cursor-pointer
              ${selected
                ? 'bg-[#1a2a3e] border border-[#3794ff] text-white'
                : 'bg-[#111922] border border-[#253347] text-gray-300 hover:border-[#3794ff] hover:text-white'
              }`}
          >
            {displayLabel}
          </button>

          {/* 选中时显示 x 删除按钮 */}
          {selected && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleDelete(); }}
              className="w-[18px] h-[18px] flex items-center justify-center rounded-full bg-red-500/80 hover:bg-red-500 text-white text-[10px] leading-none cursor-pointer transition-colors shadow-sm"
              title="删除关系"
            >
              ✕
            </button>
          )}

          {/* 下拉菜单 */}
          {menuOpen && (
            <div className="absolute top-full left-0 mt-1 bg-[#1c2433] border border-[#253347] rounded shadow-lg z-50 min-w-[60px]">
              {RELATION_TYPES.map(rt => (
                <button
                  key={rt.value}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleChangeType(rt.value); }}
                  className={`block w-full px-3 py-1 text-xs font-mono text-left transition-colors
                    ${rt.value === relationType
                      ? 'text-[#3794ff] bg-[#253347]'
                      : 'text-gray-300 hover:bg-[#253347] hover:text-white'
                    }`}
                >
                  {rt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
