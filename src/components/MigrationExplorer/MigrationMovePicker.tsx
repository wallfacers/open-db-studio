import React, { useState, useMemo, useRef, useEffect } from 'react'
import { Folder, ChevronRight, ChevronDown, FolderInput } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useMigrationStore, MigTreeNode } from '../../store/migrationStore'
import { useToastStore } from '../../store/toastStore'
import { useClickOutside } from '../../hooks/useClickOutside'

interface MigrationMovePickerProps {
  node: MigTreeNode
  x: number
  y: number
  onClose: () => void
}

export const MigrationMovePicker: React.FC<MigrationMovePickerProps> = ({ node, x, y, onClose }) => {
  const { t } = useTranslation()
  const store = useMigrationStore()
  const toast = useToastStore()
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const pickerRef = useRef<HTMLDivElement>(null)

  useClickOutside(pickerRef, onClose, true)

  const currentCatId = node.parentId ? Number(node.parentId.replace('cat_', '')) : null

  // Ensure it stays on screen
  const safeX = Math.min(x, window.innerWidth - 200 - 8)
  const safeY = Math.min(y, window.innerHeight - 300 - 8)

  // Get all categories for the tree
  const categories = useMemo(() => {
    const cats: MigTreeNode[] = []
    store.nodes.forEach((n) => {
      if (n.nodeType === 'category') {
        cats.push(n)
      }
    })
    return cats
  }, [store.nodes])

  // Function to check if a category is a descendant of the current node (if node is a category)
  const isDescendant = (catId: string) => {
    if (node.nodeType !== 'category') return false
    if (catId === node.id) return true
    
    let current: MigTreeNode | undefined = store.nodes.get(catId)
    while (current && current.parentId) {
      if (current.parentId === node.id) return true
      current = store.nodes.get(current.parentId)
    }
    return false
  }

  const handleMove = async (targetCatId: number | null) => {
    if (targetCatId === currentCatId) {
      onClose()
      return
    }

    try {
      if (node.nodeType === 'job') {
        await store.moveJob(node.jobId, targetCatId)
      } else {
        await store.moveCategory(Number(node.id.replace('cat_', '')), targetCatId)
      }
      toast.show(t('common.success'))
      onClose()
    } catch (err: any) {
      console.error('Failed to move:', err)
      toast.showError(t('common.error'), String(err))
    }
  }

  const toggleExpand = (id: string) => {
    const next = new Set(expandedIds)
    if (next.has(id)) next.delete(id); else next.add(id)
    setExpandedIds(next)
  }

  const renderTree = (parentId: string | null, depth: number) => {
    const children = categories
      .filter((c) => c.parentId === parentId)
      .sort((a, b) => (a as any).sortOrder - (b as any).sortOrder || a.label.localeCompare(b.label))

    if (children.length === 0 && parentId !== null) return null

    return (
      <div className={depth > 0 ? 'ml-3' : ''}>
        {children.map((cat) => {
          const isCurrentNode = cat.id === node.id
          const isDisabled = isDescendant(cat.id)
          const targetId = Number(cat.id.replace('cat_', ''))
          const isCurrentParent = currentCatId === targetId
          const isExpanded = expandedIds.has(cat.id)
          const hasChildren = categories.some(c => c.parentId === cat.id)

          return (
            <div key={cat.id}>
              <div
                className={`flex items-center py-1.5 px-3 cursor-pointer transition-colors text-xs
                  ${isCurrentParent ? 'text-accent' : 'text-foreground-default hover:bg-background-hover hover:text-foreground'}
                  ${isDisabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!isDisabled) handleMove(targetId)
                }}
              >
                <div 
                  className="w-4 h-4 mr-0.5 flex items-center justify-center text-foreground-muted hover:text-foreground-default flex-shrink-0"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleExpand(cat.id)
                  }}
                >
                  {hasChildren ? (isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <div className="w-3" />}
                </div>
                <Folder size={13} className={`mr-1.5 flex-shrink-0 ${isCurrentParent ? 'text-accent' : 'text-foreground-muted'}`} />
                <span className="truncate flex-1">{cat.label} {isCurrentNode && <span className="text-[10px] opacity-60">({t('common.current')})</span>}</span>
              </div>
              {isExpanded && renderTree(cat.id, depth + 1)}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div
      ref={pickerRef}
      className="fixed z-50 bg-background-elevated border border-border-strong rounded shadow-lg py-1 min-w-[200px] max-h-[300px] flex flex-col overflow-hidden"
      style={{ left: safeX, top: safeY }}
      onClick={e => e.stopPropagation()}
    >
      <div className="px-3 py-1 text-[10px] text-foreground-subtle uppercase tracking-wide select-none">
        {t('migration.move')}
      </div>
      <div className="h-px bg-border-strong my-1 flex-shrink-0" />
      
      <div className="flex-1 overflow-y-auto">
        {renderTree(null, 0)}
      </div>

      {currentCatId !== null && (
        <>
          <div className="h-px bg-border-strong my-1 flex-shrink-0" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground-default hover:bg-background-hover hover:text-foreground transition-colors duration-150"
            onClick={() => handleMove(null)}
          >
            <FolderInput size={13} />
            {t('migration.rootCategory')}
          </button>
        </>
      )}
    </div>
  )
}

