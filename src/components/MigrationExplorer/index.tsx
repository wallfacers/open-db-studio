import { useState, useEffect, useRef, useMemo } from 'react'
import { ArrowLeftRight, Search, FolderPlus, FilePlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useMigrationStore } from '../../store/migrationStore'
import { MigrationTaskTree } from './MigrationTaskTree'
import { useQueryStore } from '../../store/queryStore'
import { PromptModal } from '../common/PromptModal'
import { BaseModal } from '../common/BaseModal'
import { DropdownSelect } from '../common/DropdownSelect'

interface Props {
  sidebarWidth: number
  onResize: (width: number) => void
  hidden?: boolean
}

interface JobModalState {
  isOpen: boolean
  name: string
  parentId: number | undefined
  nameError: string | null
  loading: boolean
}

export function MigrationExplorer({ sidebarWidth, onResize, hidden }: Props) {
  const { t } = useTranslation()
  const store = useMigrationStore()
  const openMigrationJobTab = useQueryStore(s => s.openMigrationJobTab)
  const [searchQuery, setSearchQuery] = useState('')
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null)
  const jobNameRef = useRef<HTMLInputElement>(null)

  const [promptConfig, setPromptConfig] = useState<{
    isOpen: boolean;
    type: 'category';
    parentId?: number;
  }>({ isOpen: false, type: 'category' });

  const [jobModal, setJobModal] = useState<JobModalState>({
    isOpen: false, name: '', parentId: undefined, nameError: null, loading: false,
  })

  const categories = useMemo(() =>
    Array.from(store.nodes.values())
      .filter(n => n.nodeType === 'category')
      .map(n => ({ value: String(Number(n.id.replace('cat_', ''))), label: n.label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [store.nodes]
  )

  useEffect(() => {
    store.init()
    const unlisten = store.startListening()
    return unlisten
  }, [])

  useEffect(() => {
    if (jobModal.isOpen) {
      setTimeout(() => { jobNameRef.current?.select() }, 50)
    }
  }, [jobModal.isOpen])

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

  const validateCategoryName = (name: string) => {
    const exists = Array.from(store.nodes.values()).some(n =>
      n.nodeType === 'category' && n.label.toLowerCase() === name.toLowerCase()
    )
    if (exists) return t('migration.nameExists', { defaultValue: 'Name already exists' })
    return null
  }

  const openJobModal = (parentId?: number) => {
    setJobModal({
      isOpen: true,
      name: t('migration.defaultJobName'),
      parentId,
      nameError: null,
      loading: false,
    })
  }

  const closeJobModal = () => {
    setJobModal({ isOpen: false, name: '', parentId: undefined, nameError: null, loading: false })
  }

  const handleCreateCategorySubmit = async (name: string) => {
    await store.createCategory(name, promptConfig.parentId)
    setPromptConfig({ ...promptConfig, isOpen: false })
  }

  const handleCreateJobSubmit = async () => {
    const name = jobModal.name.trim()
    if (!name) {
      setJobModal(m => ({ ...m, nameError: t('commonComponents.prompt.required', { defaultValue: 'Value is required' }) }))
      return
    }
    const exists = Array.from(store.nodes.values()).some(
      n => n.nodeType === 'job' && n.label.toLowerCase() === name.toLowerCase()
    )
    if (exists) {
      setJobModal(m => ({ ...m, nameError: t('migration.nameExists', { defaultValue: 'Name already exists' }) }))
      return
    }
    setJobModal(m => ({ ...m, loading: true }))
    try {
      const id = await store.createJob(name, jobModal.parentId)
      handleOpenJob(id, name)
      closeJobModal()
    } catch (e: any) {
      setJobModal(m => ({ ...m, loading: false, nameError: e.message || 'Error' }))
    }
  }

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
            onClick={() => openJobModal()}
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
        onCreateItem={(type, parentId) => {
          if (type === 'category') {
            setPromptConfig({ isOpen: true, type: 'category', parentId })
          } else {
            openJobModal(parentId)
          }
        }}
      />

      {/* Category creation modal */}
      {promptConfig.isOpen && (
        <PromptModal
          title={t('migration.newCategory')}
          label={t('common.name', { defaultValue: 'Name' })}
          initialValue={t('migration.defaultCategoryName')}
          onClose={() => setPromptConfig({ ...promptConfig, isOpen: false })}
          onConfirm={handleCreateCategorySubmit}
          validate={validateCategoryName}
        />
      )}

      {/* Job creation modal */}
      {jobModal.isOpen && (
        <BaseModal
          title={t('migration.newJob')}
          onClose={closeJobModal}
          width={400}
          footerButtons={[
            { label: t('common.cancel'), onClick: closeJobModal, variant: 'secondary' },
            { label: t('common.confirm'), onClick: handleCreateJobSubmit, variant: 'primary', loading: jobModal.loading },
          ]}
        >
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label className="text-[13px] text-foreground-default font-medium">
                {t('common.name', { defaultValue: 'Name' })}
              </label>
              <input
                ref={jobNameRef}
                type="text"
                value={jobModal.name}
                onChange={e => setJobModal(m => ({ ...m, name: e.target.value, nameError: null }))}
                onKeyDown={e => { if (e.key === 'Enter') handleCreateJobSubmit() }}
                className="w-full bg-background-base border border-border-strong rounded px-3 py-1.5 text-[13px] text-foreground-default placeholder-foreground-muted focus:border-accent-hover outline-none transition-colors"
              />
              {jobModal.nameError && <span className="text-error text-xs">{jobModal.nameError}</span>}
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-[13px] text-foreground-default font-medium">
                {t('migration.targetCategory', { defaultValue: '所属目录' })}
              </label>
              <DropdownSelect
                value={jobModal.parentId !== undefined ? String(jobModal.parentId) : ''}
                options={[
                  { value: '', label: t('migration.rootCategory', { defaultValue: '根目录' }) },
                  ...categories,
                ]}
                onChange={val => setJobModal(m => ({ ...m, parentId: val ? Number(val) : undefined }))}
                className="w-full"
              />
            </div>
          </div>
        </BaseModal>
      )}
    </div>
  )
}
