import { useState, useEffect, useRef } from 'react'
import { ArrowLeftRight, Search, FolderPlus, FilePlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useMigrationStore } from '../../store/migrationStore'
import { MigrationTaskTree } from './MigrationTaskTree'
import { useQueryStore } from '../../store/queryStore'
import { PromptModal } from '../common/PromptModal'

interface Props {
  sidebarWidth: number
  onResize: (width: number) => void
  hidden?: boolean
}

export function MigrationExplorer({ sidebarWidth, onResize, hidden }: Props) {
  const { t } = useTranslation()
  const store = useMigrationStore()
  const openMigrationJobTab = useQueryStore(s => s.openMigrationJobTab)
  const [searchQuery, setSearchQuery] = useState('')
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null)
  
  const [promptConfig, setPromptConfig] = useState<{
    isOpen: boolean;
    type: 'category' | 'job';
    parentId?: number;
  }>({ isOpen: false, type: 'category' });

  useEffect(() => {
    store.init()
    const unlisten = store.startListening()
    return unlisten
  }, [])

  const handleOpenJob = (jobId: number, jobName: string) => {
    openMigrationJobTab(jobId, jobName)
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    resizeRef.current = { startX: e.clientX, startW: sidebarWidth }
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      const delta = ev.clientX - resizeRef.current.startX
      onResize(Math.max(180, Math.min(400, resizeRef.current.startW + delta)))
    }
    const onUp = () => {
      resizeRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const validateName = (name: string, isCategory: boolean) => {
    const exists = Array.from(store.nodes.values()).some(n => 
      n.nodeType === (isCategory ? 'category' : 'job') && n.label.toLowerCase() === name.toLowerCase()
    );
    if (exists) {
      return t('migration.nameExists', { defaultValue: 'Name already exists' });
    }
    return null;
  };

  const handleCreateSubmit = async (name: string) => {
    if (promptConfig.type === 'category') {
      await store.createCategory(name, promptConfig.parentId);
    } else {
      const id = await store.createJob(name, promptConfig.parentId);
      handleOpenJob(id, name);
    }
    setPromptConfig({ ...promptConfig, isOpen: false });
  };

  if (hidden) return null

  return (
    <div
      className="relative flex flex-col bg-background-base border-r border-border-default flex-shrink-0 h-full"
      style={{ width: sidebarWidth }}
    >
      {/* Resize handle */}
      <div
        className="absolute right-[-2px] top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent z-10"
        onMouseDown={handleMouseDown}
      />

      {/* Header */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-border-default flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <ArrowLeftRight size={14} className="text-accent flex-shrink-0" />
          <span className="text-[13px] font-medium text-foreground-default truncate">
            {t('migration.title')}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            title={t('migration.newCategory')}
            className="p-1 rounded text-foreground-muted hover:text-foreground hover:bg-background-hover transition-colors duration-150"
            onClick={() => setPromptConfig({ isOpen: true, type: 'category' })}
          >
            <FolderPlus size={14} />
          </button>
          <button
            title={t('migration.newJob')}
            className="p-1 rounded text-foreground-muted hover:text-foreground hover:bg-background-hover transition-colors duration-150"
            onClick={() => setPromptConfig({ isOpen: true, type: 'job' })}
          >
            <FilePlus size={14} />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="h-10 flex items-center px-2 border-b border-border-default flex-shrink-0">
        <div className="flex items-center gap-1.5 bg-background-elevated border border-border-strong rounded px-2 py-1 w-full">
          <Search size={13} className="text-foreground-muted flex-shrink-0" />
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={t('migration.title') + '...'}
            className="bg-transparent border-none outline-none text-[12px] text-foreground-default placeholder:text-foreground-subtle flex-1 min-w-0"
          />
        </div>
      </div>

      {/* Tree */}
      <MigrationTaskTree 
        searchQuery={searchQuery} 
        onOpenJob={handleOpenJob} 
        onCreateItem={(type, parentId) => setPromptConfig({ isOpen: true, type, parentId })}
      />
      
      {promptConfig.isOpen && (
        <PromptModal
          title={promptConfig.type === 'category' ? t('migration.newCategory') : t('migration.newJob')}
          label={t('common.name', { defaultValue: 'Name' })}
          initialValue={promptConfig.type === 'category' ? t('migration.defaultCategoryName') : t('migration.defaultJobName')}
          onClose={() => setPromptConfig({ ...promptConfig, isOpen: false })}
          onConfirm={handleCreateSubmit}
          validate={(val) => validateName(val, promptConfig.type === 'category')}
        />
      )}
    </div>
  )
}
