import { useRef, useState, useCallback, useMemo } from 'react'
import {
  ChevronRight, ChevronDown, Folder, FolderOpen,
  ArrowLeftRight, Loader2, CheckCircle2, XCircle, Square,
  FolderPlus, FilePlus, Pencil, Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useMigrationStore, MigTreeNode } from '../../store/migrationStore'
import { migCatNodeId, migJobNodeId } from '../../utils/nodeId'
import { Tooltip } from '../common/Tooltip'

interface Props {
  searchQuery: string
  onOpenJob: (jobId: number, jobName: string) => void
  onCreateItem?: (type: 'category' | 'job', parentId?: number) => void
}

type VisibleNode = MigTreeNode & { depth: number }

function computeVisible(
  nodes: Map<string, MigTreeNode>,
  expandedIds: Set<string>,
  searchQuery: string,
): VisibleNode[] {
  const result: VisibleNode[] = []
  const q = searchQuery.toLowerCase()

  // Pre-build parent -> children index
  const byParent = new Map<string | null, MigTreeNode[]>()
  for (const node of nodes.values()) {
    const list = byParent.get(node.parentId) ?? []
    list.push(node)
    byParent.set(node.parentId, list)
  }
  // Sort each group once
  for (const list of byParent.values()) {
    list.sort((a, b) => {
      if (a.nodeType === 'category' && b.nodeType === 'job') return -1
      if (a.nodeType === 'job' && b.nodeType === 'category') return 1
      const so = (a.nodeType === 'category' ? a.sortOrder : 0) - (b.nodeType === 'category' ? b.sortOrder : 0)
      return so || a.label.localeCompare(b.label)
    })
  }

  function visit(parentId: string | null, depth: number) {
    const children = byParent.get(parentId)
    if (!children) return
    for (const node of children) {
      if (q && !node.label.toLowerCase().includes(q)) {
        if (node.nodeType === 'category') visit(node.id, depth + 1)
        continue
      }
      result.push({ ...node, depth })
      if (node.nodeType === 'category' && (expandedIds.has(node.id) || !!q)) {
        visit(node.id, depth + 1)
      }
    }
  }
  visit(null, 0)
  return result
}

export function MigrationTaskTree({ searchQuery, onOpenJob, onCreateItem }: Props) {
  const { t } = useTranslation()
  const store = useMigrationStore()
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: MigTreeNode } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const editRef = useRef<HTMLInputElement>(null)

  const visible = useMemo(
    () => computeVisible(store.nodes, store.expandedIds, searchQuery),
    [store.nodes, store.expandedIds, searchQuery],
  )

  const handleContextMenu = useCallback((e: React.MouseEvent, node: MigTreeNode) => {
    e.preventDefault()
    store.selectNode(node.id)
    setCtxMenu({ x: e.clientX, y: e.clientY, node })
  }, [store])

  const startEdit = (node: MigTreeNode) => {
    setEditingId(node.id)
    setEditValue(node.label)
    setTimeout(() => editRef.current?.select(), 50)
  }

  const commitEdit = async () => {
    if (!editingId || !editValue.trim()) { setEditingId(null); return }
    const node = store.nodes.get(editingId)
    if (!node) { setEditingId(null); return }
    
    // Check duplicates
    const newName = editValue.trim();
    if (newName !== node.label) {
      const exists = Array.from(store.nodes.values()).some(n => 
        n.nodeType === node.nodeType && n.label.toLowerCase() === newName.toLowerCase()
      );
      if (exists) {
        // Just cancel edit if exists, or we could show a toast. For now, cancel.
        setEditingId(null);
        return;
      }
      
      if (node.nodeType === 'category') await store.renameCategory(Number(editingId.replace('cat_', '')), newName)
      else if (node.nodeType === 'job') await store.renameJob(node.jobId, newName)
    }
    setEditingId(null)
  }

  const getJobStatusIcon = (status: string | null) => {
    if (status === 'RUNNING') return <Loader2 size={14} className="text-accent animate-spin flex-shrink-0" />
    if (status === 'FINISHED') return <CheckCircle2 size={14} className="text-success flex-shrink-0" />
    if (status === 'FAILED') return <XCircle size={14} className="text-error flex-shrink-0" />
    if (status === 'STOPPED') return <Square size={14} className="text-foreground-muted flex-shrink-0" />
    if (status === 'PARTIAL_FAILED') return <XCircle size={14} className="text-warning flex-shrink-0" />
    return <ArrowLeftRight size={14} className="text-foreground-muted flex-shrink-0" />
  }

  return (
    <div className="flex-1 overflow-y-auto select-none" onClick={() => setCtxMenu(null)}>
      {visible.map(node => {
        const isSelected = store.selectedId === node.id
        const isExpanded = store.expandedIds.has(node.id)
        const isEditing = editingId === node.id

        return (
          <div
            key={node.id}
            className={`flex items-center py-1 px-2 cursor-pointer outline-none
              hover:bg-background-hover transition-colors duration-150
              ${isSelected ? 'bg-border-default' : ''}`}
            style={{ paddingLeft: `${node.depth * 16 + 8}px` }}
            onClick={() => {
              store.selectNode(node.id)
              if (node.nodeType === 'category') store.toggleExpand(node.id)
              else if (node.nodeType === 'job') onOpenJob(node.jobId, node.label)
            }}
            onContextMenu={e => handleContextMenu(e, node)}
          >
            {/* Chevron */}
            <div className="w-4 h-4 mr-1 flex items-center justify-center text-foreground-muted flex-shrink-0">
              {node.nodeType === 'category'
                ? isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
                : null}
            </div>

            {/* Icon */}
            {node.nodeType === 'category'
              ? isExpanded
                ? <FolderOpen size={14} className="text-accent mr-1.5 flex-shrink-0" />
                : <Folder size={14} className="text-foreground-muted mr-1.5 flex-shrink-0" />
              : <span className="mr-1.5">{getJobStatusIcon(node.status)}</span>}

            {/* Label or inline edit */}
            {isEditing ? (
              <input
                ref={editRef}
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditingId(null) }}
                className="flex-1 text-[13px] bg-background-base border border-accent rounded px-1 outline-none text-foreground-default"
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <Tooltip content={node.label}>
                <span className="text-[13px] truncate flex-1 text-foreground-default">{node.label}</span>
              </Tooltip>
            )}

            {/* Status badge for jobs */}
            {node.nodeType === 'job' && node.status === 'RUNNING' && (
              <span className="text-[10px] px-1 rounded text-accent bg-accent/10 flex-shrink-0 ml-1">
                {t('migration.statusRunning')}
              </span>
            )}
            {node.nodeType === 'job' && node.status === 'FAILED' && (
              <span className="text-[10px] px-1 rounded text-error bg-error-subtle flex-shrink-0 ml-1">
                {t('migration.statusFailed')}
              </span>
            )}
            {node.nodeType === 'job' && node.status === 'PARTIAL_FAILED' && (
              <span className="text-[10px] px-1 rounded text-warning bg-warning/10 flex-shrink-0 ml-1">
                {t('migration.statusPartialFailed', { defaultValue: 'PARTIAL' })}
              </span>
            )}
            {node.nodeType === 'job' && node.status === 'STOPPED' && (
              <span className="text-[10px] px-1 rounded text-foreground-muted bg-background-hover flex-shrink-0 ml-1">
                {t('migration.statusStopped')}
              </span>
            )}
          </div>
        )
      })}

      {/* Context Menu */}
      {ctxMenu && (
        <div
          className="fixed z-50 bg-background-base border border-border-default rounded shadow-xl py-1 min-w-[160px]"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          {ctxMenu.node.nodeType === 'category' && (<>
            <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground-default hover:bg-background-hover transition-colors duration-150"
              onClick={() => { onCreateItem?.('category', Number(ctxMenu.node.id.replace('cat_', ''))); setCtxMenu(null) }}>
              <FolderPlus size={13} />{t('migration.newCategory')}
            </button>
            <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground-default hover:bg-background-hover transition-colors duration-150"
              onClick={() => { onCreateItem?.('job', Number(ctxMenu.node.id.replace('cat_', ''))); setCtxMenu(null) }}>
              <FilePlus size={13} />{t('migration.newJob')}
            </button>
            <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground-default hover:bg-background-hover transition-colors duration-150"
              onClick={() => { startEdit(ctxMenu.node); setCtxMenu(null) }}>
              <Pencil size={13} />{t('migration.rename')}
            </button>
            <div className="border-t border-border-subtle my-1" />
            <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-error hover:bg-background-hover transition-colors duration-150"
              onClick={() => { store.deleteCategory(Number(ctxMenu.node.id.replace('cat_', ''))); setCtxMenu(null) }}>
              <Trash2 size={13} />{t('migration.delete')}
            </button>
          </>)}

          {ctxMenu.node.nodeType === 'job' && (() => {
            const jobNode = ctxMenu.node
            return (<>
              {jobNode.status !== 'RUNNING' && (
                <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground-default hover:bg-background-hover transition-colors duration-150"
                  onClick={() => { onOpenJob(jobNode.jobId, jobNode.label); setCtxMenu(null) }}>
                  <ArrowLeftRight size={13} />{t('migration.open')}
                </button>
              )}
              {jobNode.status === 'RUNNING' && (
                <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-error hover:bg-background-hover transition-colors duration-150"
                  onClick={() => { setCtxMenu(null) }}>
                  <XCircle size={13} />{t('migration.stop')}
                </button>
              )}
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground-default hover:bg-background-hover transition-colors duration-150"
                onClick={() => { startEdit(jobNode); setCtxMenu(null) }}>
                <Pencil size={13} />{t('migration.rename')}
              </button>
              <div className="border-t border-border-subtle my-1" />
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-error hover:bg-background-hover transition-colors duration-150"
                onClick={() => { store.deleteJob(jobNode.jobId); setCtxMenu(null) }}>
                <Trash2 size={13} />{t('migration.delete')}
              </button>
            </>)
          })()}
        </div>
      )}
    </div>
  )
}
