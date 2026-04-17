import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useConnectionStore } from '../../store/connectionStore'
import { DropdownSelect } from './DropdownSelect'

export interface ConnectionDbSelectorProps {
  connectionId: number          // 0 = 未选
  database: string              // '' = 未选
  onConnectionChange: (connectionId: number) => void
  onDatabaseChange: (database: string) => void
  connectionPlaceholder?: string
  databasePlaceholder?: string
  direction?: 'vertical' | 'horizontal'  // 默认 vertical
  className?: string
}

export function ConnectionDbSelector({
  connectionId,
  database,
  onConnectionChange,
  onDatabaseChange,
  connectionPlaceholder = '请选择连接',
  databasePlaceholder = '请选择数据库',
  direction = 'vertical',
  className,
}: ConnectionDbSelectorProps) {
  const { connections, loadConnections } = useConnectionStore()
  const [databases, setDatabases] = useState<string[]>([])
  const [dbLoading, setDbLoading] = useState(false)
  const [dbError, setDbError] = useState<string | null>(null)

  useEffect(() => {
    if (connections.length === 0) loadConnections()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!connectionId) {
      setDatabases([])
      setDbError(null)
      return
    }
    let cancelled = false
    setDbLoading(true)
    setDbError(null)
    invoke<string[]>('list_databases_for_metrics', { connectionId })
      .then(dbs => { if (!cancelled) setDatabases(dbs) })
      .catch(err => {
        if (!cancelled) {
          setDatabases([])
          setDbError(typeof err === 'string' ? err : '加载失败')
        }
      })
      .finally(() => { if (!cancelled) setDbLoading(false) })
    return () => { cancelled = true }
  }, [connectionId])

  const dbPlaceholder = dbLoading ? '加载中...' : (dbError ?? databasePlaceholder)

  const connSelect = (
    <DropdownSelect
      value={connectionId ? String(connectionId) : ''}
      options={connections.map(c => ({ value: String(c.id), label: c.name }))}
      placeholder={connectionPlaceholder}
      onChange={val => onConnectionChange(val ? Number(val) : 0)}
      className="w-full"
    />
  )

  const dbSelect = (
    <DropdownSelect
      value={database}
      options={databases.map(db => ({ value: db, label: db }))}
      placeholder={dbPlaceholder}
      onChange={onDatabaseChange}
      className="w-full"
    />
  )

  if (direction === 'horizontal') {
    return (
      <div className={`flex items-center gap-2 ${className ?? ''}`}>
        <div className="w-36">{connSelect}</div>
        {connectionId > 0 && (
          <div className="w-32">{dbSelect}</div>
        )}
        {connectionId > 0 && dbError && (
          <span className="text-[11px] text-error" title={dbError}>!</span>
        )}
      </div>
    )
  }

  return (
    <div className={`flex flex-col gap-2 ${className ?? ''}`}>
      {connSelect}
      {dbSelect}
      {dbError && (
        <span className="text-[11px] text-error">{dbError}</span>
      )}
    </div>
  )
}
