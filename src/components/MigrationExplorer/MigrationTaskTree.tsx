import { useRef, useState, useCallback, useMemo } from 'react'
import {
  ChevronRight, ChevronDown, Folder, FolderOpen,
  ArrowLeftRight, Loader2, CheckCircle2, XCircle, Square,
  FolderPlus, FilePlus, Pencil, Trash2, FolderInput,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useMigrationStore, MigTreeNode, isCategoryEmpty } from '../../store/migrationStore'
import { migCatNodeId, migJobNodeId } from '../../utils/nodeId'
import { Tooltip } from '../common/Tooltip'
import { MigrationMovePicker } from './MigrationMovePicker'

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
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [movePicker, setMovePicker] = useState<{ x: number; y: number; node: MigTreeNode } | null>(null)
  const editRef = useRef<HTMLInputElement>(null)

  const visible = useMemo(
    () => computeVisible(store.nodes, store.expandedIds, searchQuery),
    [store.nodes, store.expandedIds, searchQuery],
  )

  // ── Drag & Drop ────────────────────────────────────────────
  const handleDragStart = useCallback((e: React.DragEvent, node: MigTreeNode) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ nodeType: node.nodeType, id: node.id }))
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, node: MigTreeNode) => {
    // Only allow dropping onto categories
    if (node.nodeType !== 'category') return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverId(node.id)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    setDragOverId(null)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent, targetNode: MigTreeNode) => {
    e.preventDefault()
    setDragOverId(null)
    if (targetNode.nodeType !== 'category') return

    let data: { nodeType: string; id: string }
    try {
      data = JSON.parse(e.dataTransfer.getData('text/plain'))
    } catch { return }

    const targetCatId = Number(targetNode.id.replace('cat_', ''))

    if (data.nodeType === 'job') {
      const jobId = Number(data.id.replace('job_', ''))
      await store.moveJob(jobId, targetCatId)
    } else if (data.nodeType === 'category') {
      const catId = Number(data.id.replace('cat_', ''))
      if (catId === targetCatId) return
      try {
        await store.moveCategory(catId, targetCatId)
      } catch (err: any) {
        console.error('[MigrationTree] move category failed:', err)
      }
    }
  }, [store])

  const handleDropToRoot = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOverId(null)
    let data: { nodeType: string; id: string }
    try {
      data = JSON.parse(e.dataTransfer.getData('text/plain'))
    } catch { return }

    if (data.nodeType === 'job') {
      const jobId = Number(data.id.replace('job_', ''))
      await store.moveJob(jobId, null)
    } else if (data.nodeType === 'category') {
      const catId = Number(data.id.replace('cat_', ''))
      try {
        await store.moveCategory(catId, null)
      } catch (err: any) {
        console.error('[MigrationTree] move category to root failed:', err)
      }
    }
  }, [store])

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
    <div
      className="flex-1 overflow-y-auto select-none"
      onClick={() => setCtxMenu(null)}
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
      onDrop={handleDropToRoot}
    >
      {visible.map(node => {
        const isSelected = store.selectedId === node.id
        const isExpanded = store.expandedIds.has(node.id)
        const isEditing = editingId === node.id

        return (
          <div
            key={node.id}
            draggable
            onDragStart={e => handleDragStart(e, node)}
            className={`flex items-center py-1 px-2 cursor-pointer outline-none
              hover:bg-background-hover transition-colors duration-150
              ${isSelected ? 'bg-border-default' : ''}
              ${dragOverId === node.id && node.nodeType === 'category' ? 'bg-accent/10 border-l-2 border-accent' : ''}`}
            style={{ paddingLeft: `${node.depth * 16 + 8}px` }}
            onClick={() => {
              store.selectNode(node.id)
              if (node.nodeType === 'category') store.toggleExpand(node.id)
              else if (node.nodeType === 'job') onOpenJob(node.jobId, node.label)
            }}
            onContextMenu={e => handleContextMenu(e, node)}
            onDragOver={node.nodeType === 'category' ? e => handleDragOver(e, node) : undefined}
            onDragLeave={node.nodeType === 'category' ? handleDragLeave : undefined}
            onDrop={node.nodeType === 'category' ? e => handleDrop(e, node) : undefined}
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
      {ctxMenu && (() => {
        const isEmpty = ctxMenu.node.nodeType === 'category'
          ? isCategoryEmpty(store.nodes, ctxMenu.node.id)
          : true
        return (
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
            <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground-default hover:bg-background-hover transition-colors duration-150"
              onClick={() => { setMovePicker({ node: ctxMenu.node, x: ctxMenu.x, y: ctxMenu.y }); setCtxMenu(null) }}>
              <FolderInput size={13} />{t('migration.move')}
            </button>
            <div className="border-t border-border-subtle my-1" />
            {isEmpty ? (
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-error hover:bg-background-hover transition-colors duration-150"
                onClick={() => { store.deleteCategory(Number(ctxMenu.node.id.replace('cat_', ''))); setCtxMenu(null) }}>
                <Trash2 size={13} />{t('migration.delete')}
              </button>
            ) : (
              <Tooltip content={t('migration.deleteCategoryNotEmpty')}>
                <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-error/40 cursor-not-allowed"
                  disabled>
                  <Trash2 size={13} />{t('migration.delete')}
                </button>
              </Tooltip>
            )}
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
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground-default hover:bg-background-hover transition-colors duration-150"
                onClick={() => { setMovePicker({ node: jobNode, x: ctxMenu.x, y: ctxMenu.y }); setCtxMenu(null) }}>
                <FolderInput size={13} />{t('migration.move')}
              </button>
              <div className="border-t border-border-subtle my-1" />
              <button className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-error hover:bg-background-hover transition-colors duration-150"
                onClick={() => { store.deleteJob(jobNode.jobId); setCtxMenu(null) }}>
                <Trash2 size={13} />{t('migration.delete')}
              </button>
            </>)
          })()}
        </div>
        )
      })()}

      {movePicker && (
        <MigrationMovePicker
          node={movePicker.node}
          x={movePicker.x}
          y={movePicker.y}
          onClose={() => setMovePicker(null)}
        />
      )}
    </div>
  )
}
