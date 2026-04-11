import { useState, useEffect, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useMigrationStore, MigrationJob } from '../../store/migrationStore'
import { MigrationToolbar } from './MigrationToolbar'
import { MigrationEditor } from './MigrationEditor'
import { ResultPanel } from './ResultPanel'
import { MigrateQLLspAdapter } from './LspAdapter'

interface Props { jobId: number }

export function MigrationJobTab({ jobId }: Props) {
  const store = useMigrationStore()
  const [scriptText, setScriptText] = useState('')
  const [resultHeight, setResultHeight] = useState(0)
  const [ghostTextEnabled, setGhostTextEnabled] = useState(false)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scriptTextRef = useRef(scriptText)
  scriptTextRef.current = scriptText

  // Expose LSP adapter ref so toolbar can call format
  const lspAdapterRef = useRef<MigrateQLLspAdapter | null>(null)

  const run = store.activeRuns.get(jobId)
  const jobNode = store.nodes.get(`job_${jobId}`)
  const isRunning = jobNode?.nodeType === 'job' && jobNode.status === 'RUNNING'
  const hasFailed = jobNode?.nodeType === 'job' && jobNode.status === 'FAILED'

  // Load script from DB on mount
  useEffect(() => {
    invoke<MigrationJob[]>('list_migration_jobs')
      .then((jobs) => {
        const job = jobs.find((j) => j.id === jobId)
        if (job) setScriptText(job.scriptText)
      }).catch(() => {})
  }, [jobId])

  // Open result panel when run starts
  useEffect(() => {
    if (isRunning && resultHeight === 0) setResultHeight(250)
  }, [isRunning]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup save timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  // Auto-save on change (debounced 1s)
  const handleScriptChange = useCallback((value: string) => {
    setScriptText(value)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      try {
        await invoke('update_migration_job_script', { id: jobId, scriptText: value })
      } catch (e) {
        console.error('Auto-save failed:', e)
      }
    }, 1000)
  }, [jobId])

  // Manual save (Ctrl+S)
  const handleSave = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    try {
      await invoke('update_migration_job_script', { id: jobId, scriptText: scriptTextRef.current })
    } catch (e) {
      console.error('Save failed:', e)
    }
  }, [jobId])

  // Run: save first, then execute
  const handleRun = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    try {
      await invoke('update_migration_job_script', { id: jobId, scriptText: scriptTextRef.current })
    } catch { /* continue to run even if save fails */ }
    await store.runJob(jobId)
  }, [jobId, store])

  const handleStop = useCallback(async () => {
    await invoke('stop_migration_job', { jobId })
  }, [jobId])

  // Format via LSP
  const handleFormat = useCallback(async () => {
    try {
      const result = await invoke<string | null>('lsp_request', {
        method: 'textDocument/formatting',
        params: { text: scriptTextRef.current },
      })
      if (result) {
        setScriptText(result)
        await invoke('update_migration_job_script', { id: jobId, scriptText: result })
      }
    } catch (e) {
      console.error('Format failed:', e)
    }
  }, [jobId])

  // Splitter drag
  const handleResultResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = resultHeight
    const onMouseMove = (ev: MouseEvent) => {
      const newH = Math.max(100, Math.min(window.innerHeight - 150, startHeight - (ev.clientY - startY)))
      setResultHeight(newH)
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [resultHeight])

  return (
    <div className="flex flex-col h-full bg-background-base">
      {/* Toolbar */}
      <MigrationToolbar
        isRunning={isRunning}
        ghostTextEnabled={ghostTextEnabled}
        onRun={handleRun}
        onStop={handleStop}
        onFormat={handleFormat}
        onToggleGhostText={() => setGhostTextEnabled(v => !v)}
      />

      {/* Editor */}
      <div className="flex-1 min-h-0">
        <MigrationEditor
          value={scriptText}
          onChange={handleScriptChange}
          onSave={handleSave}
          ghostTextEnabled={ghostTextEnabled}
        />
      </div>

      {/* Result Panel (logs, stats, history) */}
      {resultHeight > 0 && (
        <ResultPanel
          jobId={jobId}
          isRunning={isRunning}
          hasFailed={hasFailed}
          stats={run?.stats ?? null}
          logs={run?.logs ?? []}
          height={resultHeight}
          onResize={handleResultResize}
          onClose={() => setResultHeight(0)}
        />
      )}
    </div>
  )
}
