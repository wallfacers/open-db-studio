import React, { useState, useMemo } from 'react'
import { X, Folder, ChevronRight, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useMigrationStore, MigTreeNode } from '../../store/migrationStore'
import { useToastStore } from '../../store/toastStore'

interface MigrationMoveModalProps {
  node: MigTreeNode
  onClose: () => void
}

export const MigrationMoveModal: React.FC<MigrationMoveModalProps> = ({ node, onClose }) => {
  const { t } = useTranslation()
  const store = useMigrationStore()
  const toast = useToastStore()
  const [selectedCatId, setSelectedCatId] = useState<number | null>(
    node.parentId ? Number(node.parentId.replace('cat_', '')) : null
  )
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

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

  const handleMove = async () => {
    try {
      if (node.nodeType === 'job') {
        await store.moveJob(node.jobId, selectedCatId)
      } else {
        await store.moveCategory(Number(node.id.replace('cat_', '')), selectedCatId)
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
      <div className={depth > 0 ? 'ml-4' : ''}>
        {children.map((cat) => {
          const isCurrentNode = cat.id === node.id
          const isDisabled = isDescendant(cat.id)
          const isSelected = selectedCatId === Number(cat.id.replace('cat_', ''))
          const isExpanded = expandedIds.has(cat.id)
          const hasChildren = categories.some(c => c.parentId === cat.id)

          return (
            <div key={cat.id}>
              <div
                className={`flex items-center py-1.5 px-2 rounded cursor-pointer transition-colors
                  ${isSelected ? 'bg-accent/20 text-accent' : 'hover:bg-background-hover'}
                  ${isDisabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                onClick={() => !isDisabled && setSelectedCatId(Number(cat.id.replace('cat_', '')))}
              >
                <div 
                  className="w-4 h-4 mr-1 flex items-center justify-center text-foreground-muted hover:text-foreground-default"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleExpand(cat.id)
                  }}
                >
                  {hasChildren ? (isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}
                </div>
                <Folder size={14} className={`mr-2 ${isSelected ? 'text-accent' : 'text-foreground-muted'}`} />
                <span className="text-sm truncate flex-1">{cat.label} {isCurrentNode && <span className="text-[10px] opacity-60">({t('common.current')})</span>}</span>
              </div>
              {isExpanded && renderTree(cat.id, depth + 1)}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]" onClick={onClose}>
      <div 
        className="bg-background-panel border border-border-strong rounded-lg w-[400px] flex flex-col max-h-[80vh] shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border-subtle">
          <h2 className="text-foreground font-semibold flex items-center gap-2">
            {t('migration.move')}: {node.label}
          </h2>
          <button onClick={onClose} className="text-foreground-muted hover:text-foreground-default transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 min-h-[200px]">
          <div className="mb-2 text-xs text-foreground-muted px-2">
            {t('migration.selectTargetCategory', { defaultValue: 'Select target category' })}
          </div>
          
          {/* Root option */}
          <div
            className={`flex items-center py-1.5 px-2 rounded cursor-pointer transition-colors mb-1
              ${selectedCatId === null ? 'bg-accent/20 text-accent' : 'hover:bg-background-hover'}`}
            onClick={() => setSelectedCatId(null)}
          >
            <div className="w-4 h-4 mr-1" />
            <Folder size={14} className={`mr-2 ${selectedCatId === null ? 'text-accent' : 'text-foreground-muted'}`} />
            <span className="text-sm">{t('migration.rootCategory')}</span>
          </div>

          {renderTree(null, 0)}
        </div>

        <div className="p-4 border-t border-border-subtle flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm bg-background-hover hover:bg-border-strong text-foreground rounded transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleMove}
            disabled={node.nodeType === 'category' ? (selectedCatId === (node.parentId ? Number(node.parentId.replace('cat_', '')) : null)) : false}
            className="px-4 py-1.5 text-sm bg-accent hover:bg-accent-hover text-foreground rounded disabled:opacity-50 transition-colors"
          >
            {t('migration.move')}
          </button>
        </div>
      </div>
    </div>
  )
}
