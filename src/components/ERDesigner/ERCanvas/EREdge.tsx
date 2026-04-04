import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  BaseEdge, EdgeLabelRenderer, getSmoothStepPath, useStore,
  type EdgeProps, Position,
} from '@xyflow/react';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import { parseErEdgeNodeId } from '../../../utils/nodeId';
import { CONSTRAINT_BADGE, CONSTRAINT_METHOD_OPTIONS, COMMENT_FORMAT_OPTIONS } from '../shared/constraintConstants';
import { resolveConstraintMethod, resolveCommentFormat } from '../shared/resolveConstraint';

// ─── Crossing detection types ───────────────────────────────────────

interface Point { x: number; y: number }
interface Segment { x1: number; y1: number; x2: number; y2: number }
interface CrossingPoint extends Point {
  /** Is the current edge's segment horizontal at this crossing? */
  isHorizontal: boolean;
}

const JUMP_RADIUS = 6;
const BORDER_RADIUS = 8;

// ─── SVG path → straight segments (skip Q/C curves) ────────────────

function pathToSegments(d: string): Segment[] {
  const segs: Segment[] = [];
  const re = /([MLHVQCSZ])\s*([\d.,eE\s+-]*)/gi;
  let cx = 0, cy = 0, m;

  while ((m = re.exec(d)) !== null) {
    const nums = m[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    switch (m[1].toUpperCase()) {
      case 'M': cx = nums[0]; cy = nums[1]; break;
      case 'L': { const nx = nums[0], ny = nums[1]; segs.push({ x1: cx, y1: cy, x2: nx, y2: ny }); cx = nx; cy = ny; break; }
      case 'H': { const nx = nums[0]; segs.push({ x1: cx, y1: cy, x2: nx, y2: cy }); cx = nx; break; }
      case 'V': { const ny = nums[0]; segs.push({ x1: cx, y1: cy, x2: cx, y2: ny }); cy = ny; break; }
      case 'Q': cx = nums[2]; cy = nums[3]; break;
      case 'C': cx = nums[4]; cy = nums[5]; break;
    }
  }
  return segs;
}

// ─── Segment intersection ───────────────────────────────────────────

function segmentIntersection(a: Segment, b: Segment): Point | null {
  const dax = a.x2 - a.x1, day = a.y2 - a.y1;
  const dbx = b.x2 - b.x1, dby = b.y2 - b.y1;
  const denom = dax * dby - day * dbx;
  if (Math.abs(denom) < 1e-10) return null; // parallel / collinear

  const t = ((b.x1 - a.x1) * dby - (b.y1 - a.y1) * dbx) / denom;
  const u = ((b.x1 - a.x1) * day - (b.y1 - a.y1) * dax) / denom;

  const eps = 0.02;
  if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;

  return { x: a.x1 + t * dax, y: a.y1 + t * day };
}

// ─── Get handle positions for an edge from ReactFlow store ──────────

function getEdgeEndpoints(
  edge: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null },
  nodeLookup: Map<string, any>,
) {
  const sNode = nodeLookup.get(edge.source);
  const tNode = nodeLookup.get(edge.target);
  if (!sNode || !tNode) return null;

  const sBounds = sNode.internals?.handleBounds?.source;
  const tBounds = tNode.internals?.handleBounds?.target;
  if (!sBounds?.length || !tBounds?.length) return null;

  const sH = edge.sourceHandle ? sBounds.find((h: any) => h.id === edge.sourceHandle) : sBounds[0];
  const tH = edge.targetHandle ? tBounds.find((h: any) => h.id === edge.targetHandle) : tBounds[0];
  if (!sH || !tH) return null;

  const sPos = sNode.internals.positionAbsolute;
  const tPos = tNode.internals.positionAbsolute;

  return {
    sourceX: sPos.x + sH.x + sH.width / 2,
    sourceY: sPos.y + sH.y + sH.height / 2,
    targetX: tPos.x + tH.x + tH.width / 2,
    targetY: tPos.y + tH.y + tH.height / 2,
  };
}

// ─── Compute crossings with lower-z-order edges ────────────────────

function computeCrossings(
  myPath: string,
  myId: string,
  storeEdges: any[],
  nodeLookup: Map<string, any>,
): CrossingPoint[] {
  const mySegs = pathToSegments(myPath);
  const myIdx = storeEdges.findIndex((e: any) => e.id === myId);
  if (myIdx <= 0) return [];

  const crossings: CrossingPoint[] = [];

  for (let i = 0; i < myIdx; i++) {
    const other = storeEdges[i];
    const ep = getEdgeEndpoints(other, nodeLookup);
    if (!ep) continue;

    const [otherPath] = getSmoothStepPath({
      ...ep,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      borderRadius: BORDER_RADIUS,
    });

    const otherSegs = pathToSegments(otherPath);
    for (const mySeg of mySegs) {
      const isH = Math.abs(mySeg.y2 - mySeg.y1) < Math.abs(mySeg.x2 - mySeg.x1);
      for (const oSeg of otherSegs) {
        const p = segmentIntersection(mySeg, oSeg);
        if (p) crossings.push({ ...p, isHorizontal: isH });
      }
    }
  }

  return crossings;
}

// ─── Point along path (for on-edge label placement) ────────────────

/** Return a point at fraction t ∈ [0,1] of total segment length */
function getPointOnSegments(segs: Segment[], t: number): Point | null {
  if (segs.length === 0) return null;
  let total = 0;
  const lens = segs.map(s => {
    const l = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    total += l;
    return l;
  });
  if (total === 0) return null;

  let rem = t * total;
  for (let i = 0; i < segs.length; i++) {
    if (rem <= lens[i] || i === segs.length - 1) {
      const r = lens[i] > 0 ? rem / lens[i] : 0;
      return {
        x: segs[i].x1 + r * (segs[i].x2 - segs[i].x1),
        y: segs[i].y1 + r * (segs[i].y2 - segs[i].y1),
      };
    }
    rem -= lens[i];
  }
  const last = segs[segs.length - 1];
  return { x: last.x2, y: last.y2 };
}

// Candidate positions along edge (fraction of total length)
const LABEL_T_CANDIDATES = [0.5, 0.35, 0.65, 0.25, 0.75];
const LABEL_HIT_W = 48;
const LABEL_HIT_H = 24;

/** Pick a non-overlapping position for `segs`, given already-placed labels */
function resolveLabelPos(segs: Segment[], placed: Point[]): Point | null {
  for (const t of LABEL_T_CANDIDATES) {
    const pt = getPointOnSegments(segs, t);
    if (!pt) continue;
    const overlaps = placed.some(
      p => Math.abs(pt.x - p.x) < LABEL_HIT_W && Math.abs(pt.y - p.y) < LABEL_HIT_H,
    );
    if (!overlaps) return pt;
  }
  return getPointOnSegments(segs, 0.5); // fallback: midpoint
}

// ─── Edge constants ─────────────────────────────────────────────────

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

const BG_COLOR = 'var(--background-base)';
const SELECTED_COLOR = 'var(--accent)';

// ─── Component ──────────────────────────────────────────────────────

export default function EREdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  data, style, selected,
}: EdgeProps) {
  // ── Smoothstep path ────────────────────────────────────────────
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY,
    sourcePosition: sourcePosition || Position.Right,
    targetX, targetY,
    targetPosition: targetPosition || Position.Left,
    borderRadius: BORDER_RADIUS,
  });

  // ── Store data for crossing & label overlap detection ────────
  const storeEdges = useStore(s => s.edges);
  const nodeLookup = useStore(s => s.nodeLookup);

  // ── Line-jump crossing detection ──────────────────────────────
  const crossings = useMemo(
    () => computeCrossings(edgePath, id, storeEdges, nodeLookup),
    [edgePath, id, storeEdges, nodeLookup],
  );

  // ── Label on-path anti-overlap ──────────────────────────────
  // Deterministic: replay earlier edges' placement, then pick a
  // non-colliding position for this edge along its own path.
  const labelPos = useMemo(() => {
    const myIdx = storeEdges.findIndex(e => e.id === id);
    const mySegs = pathToSegments(edgePath);

    // Replay earlier edges' label resolution so positions are consistent
    const placed: Point[] = [];
    for (let i = 0; i < Math.max(myIdx, 0); i++) {
      const other = storeEdges[i];
      const ep = getEdgeEndpoints(other, nodeLookup);
      if (!ep) continue;
      const [otherPath] = getSmoothStepPath({
        ...ep,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        borderRadius: BORDER_RADIUS,
      });
      const pt = resolveLabelPos(pathToSegments(otherPath), placed);
      if (pt) placed.push(pt);
    }

    return resolveLabelPos(mySegs, placed) ?? { x: labelX, y: labelY };
  }, [edgePath, labelX, labelY, id, storeEdges, nodeLookup]);

  // ── Store data ─────────────────────────────────────────────────
  const relations = useErDesignerStore(s => s.relations);
  const tables = useErDesignerStore(s => s.tables);
  const activeProjectId = useErDesignerStore(s => s.activeProjectId);
  const projects = useErDesignerStore(s => s.projects);
  const updateRelation = useErDesignerStore(s => s.updateRelation);
  const deleteRelation = useErDesignerStore(s => s.deleteRelation);

  // ── Styling ────────────────────────────────────────────────────
  const relationType = (data?.relation_type as string) || 'one_to_many';
  const displayLabel = RELATION_LABEL_MAP[relationType] || relationType;

  const rid = parseErEdgeNodeId(id);
  const storeRelation = rid != null ? relations.find(r => r.id === rid) : undefined;
  const sourceTable = storeRelation
    ? tables.find(t => t.id === storeRelation.source_table_id)
    : undefined;
  const project = projects.find(p => p.id === activeProjectId);

  const effectiveConstraintMethod = resolveConstraintMethod(storeRelation, sourceTable, project);
  const effectiveCommentFormat = resolveCommentFormat(storeRelation, sourceTable, project);

  const [menuOpen, setMenuOpen] = useState(false);
  const labelRef = useRef<HTMLDivElement>(null);   // label container in EdgeLabelRenderer
  const dropdownRef = useRef<HTMLDivElement>(null); // portalled dropdown
  const labelBtnRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  useEffect(() => { if (!selected) setMenuOpen(false); }, [selected]);

  // Close dropdown on outside click (check both label area and portalled dropdown)
  useEffect(() => {
    if (!menuOpen) return;
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (labelRef.current?.contains(t) || dropdownRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', h, true);
    return () => document.removeEventListener('mousedown', h, true);
  }, [menuOpen]);

  // Position dropdown below the label button
  const toggleMenu = useCallback(() => {
    setMenuOpen(prev => {
      if (!prev && labelBtnRef.current) {
        const rect = labelBtnRef.current.getBoundingClientRect();
        setDropdownPos({ left: rect.left, top: rect.bottom + 4 });
      }
      return !prev;
    });
  }, []);

  const handleChangeType = (newType: string) => {
    setMenuOpen(false);
    if (newType === relationType) return;
    if (rid == null) return;
    updateRelation(rid, { relation_type: newType });
  };

  const handleChangeConstraintMethod = (newMethod: string) => {
    if (rid == null) return;
    updateRelation(rid, { constraint_method: newMethod || null });
  };

  const handleChangeCommentFormat = (newFormat: string) => {
    if (rid == null) return;
    updateRelation(rid, { comment_format: newFormat || null });
  };

  const handleDelete = () => {
    setMenuOpen(false);
    if (rid == null) return;
    deleteRelation(rid);
  };

  const baseColor = effectiveConstraintMethod === 'comment_ref'
    ? 'var(--edge-reference)'
    : 'var(--edge-fk)';
  const strokeColor = selected ? SELECTED_COLOR : baseColor;

  const edgeStyle: React.CSSProperties = {
    stroke: strokeColor,
    strokeWidth: selected ? 2.5 : 2,
    strokeDasharray: effectiveConstraintMethod === 'comment_ref' ? '6 3' : undefined,
    ...(selected ? { filter: `drop-shadow(0 0 6px ${SELECTED_COLOR})` } : {}),
  };

  // ── Render ─────────────────────────────────────────────────────
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={{ ...edgeStyle, ...style }} />

      {/* Line-jump arcs at crossing points */}
      {crossings.map((c, i) => {
        const r = JUMP_RADIUS;
        const arcPath = c.isHorizontal
          ? `M ${c.x - r},${c.y} A ${r},${r} 0 0,1 ${c.x + r},${c.y}`
          : `M ${c.x},${c.y - r} A ${r},${r} 0 0,1 ${c.x},${c.y + r}`;

        return (
          <g key={i}>
            {/* Background mask to hide crossing */}
            <circle cx={c.x} cy={c.y} r={r + 1} fill={BG_COLOR} />
            {/* Arc bridge */}
            <path
              d={arcPath}
              fill="none"
              stroke={strokeColor}
              strokeWidth={edgeStyle.strokeWidth}
              strokeDasharray={edgeStyle.strokeDasharray}
            />
          </g>
        );
      })}

      <EdgeLabelRenderer>
        <div
          ref={labelRef}
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelPos.x}px, ${labelPos.y}px)`,
            pointerEvents: 'all',
          }}
          className="flex items-center gap-1"
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            ref={labelBtnRef}
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleMenu(); }}
            className={`px-2 py-0.5 rounded text-xs font-mono shadow-sm transition-colors cursor-pointer
              ${selected
                ? 'bg-accent-subtle border border-accent text-accent'
                : 'bg-background-panel border border-border-strong text-foreground-default hover:border-edge-fk hover:text-foreground'
              }`}
          >
            <span className="opacity-70 mr-0.5">{CONSTRAINT_BADGE[effectiveConstraintMethod] ?? ''}</span>
            {displayLabel}
          </button>

          {selected && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleDelete(); }}
              className="w-[18px] h-[18px] flex items-center justify-center rounded-full bg-error/80 hover:bg-error text-foreground text-[10px] leading-none cursor-pointer transition-colors shadow-sm"
              title="删除关系"
            >
              ✕
            </button>
          )}
        </div>
      </EdgeLabelRenderer>

      {/* Dropdown portalled to body — always on top of everything */}
      {menuOpen && createPortal(
        <div
          ref={dropdownRef}
          style={{ position: 'fixed', left: dropdownPos.left, top: dropdownPos.top, zIndex: 9999 }}
          className="bg-background-panel border border-border-strong rounded shadow-lg min-w-[60px]"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {RELATION_TYPES.map(rt => (
            <button
              key={rt.value}
              type="button"
              onClick={(e) => { e.stopPropagation(); handleChangeType(rt.value); }}
              className={`block w-full px-3 py-1 text-xs font-mono text-left transition-colors
                ${rt.value === relationType
                  ? 'text-accent bg-border-strong'
                  : 'text-foreground-default hover:bg-border-strong hover:text-foreground'
                }`}
            >
              {rt.label}
            </button>
          ))}

          {/* 约束方式 */}
          <div className="border-t border-border-strong my-1" />
          <div className="px-2 pt-0.5 pb-0.5 text-[10px] text-foreground-muted flex items-center justify-between">
            <span>约束方式</span>
            {storeRelation?.constraint_method && (
              <button type="button" onClick={() => handleChangeConstraintMethod('')}
                className="text-[9px] text-warning hover:text-foreground-default">重置</button>
            )}
          </div>
          {CONSTRAINT_METHOD_OPTIONS.map(opt => (
            <button key={opt.value} type="button"
              onClick={(e) => { e.stopPropagation(); handleChangeConstraintMethod(opt.value); }}
              className={`block w-full px-3 py-1 text-xs text-left transition-colors
                ${(storeRelation?.constraint_method ?? '') === opt.value ? 'text-accent bg-border-strong' : 'text-foreground-default hover:bg-border-strong hover:text-foreground'}`}>
              {opt.label}
            </button>
          ))}

          {/* 注释格式（仅 effectiveConstraintMethod === 'comment_ref' 时显示）*/}
          {effectiveConstraintMethod === 'comment_ref' && (
            <>
              <div className="border-t border-border-strong my-1" />
              <div className="px-2 pt-0.5 pb-0.5 text-[10px] text-foreground-muted flex items-center justify-between">
                <span>注释格式</span>
                {storeRelation?.comment_format && (
                  <button type="button" onClick={() => handleChangeCommentFormat('')}
                    className="text-[9px] text-warning hover:text-foreground-default">重置</button>
                )}
              </div>
              {COMMENT_FORMAT_OPTIONS.map(opt => (
                <button key={opt.value} type="button"
                  onClick={(e) => { e.stopPropagation(); handleChangeCommentFormat(opt.value); }}
                  className={`block w-full px-3 py-1 text-xs text-left font-mono transition-colors
                    ${(storeRelation?.comment_format ?? '') === opt.value ? 'text-accent bg-border-strong' : 'text-foreground-default hover:bg-border-strong hover:text-foreground'}`}>
                  {opt.label}
                </button>
              ))}
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
