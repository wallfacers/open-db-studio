import { useState } from 'react';
import { X } from 'lucide-react';
import { useErDesignerStore } from '@/store/erDesignerStore';
import ColumnsTab from './ColumnsTab';
import IndexesTab from './IndexesTab';
import TablePropertiesTab from './TablePropertiesTab';

type TabType = 'columns' | 'indexes' | 'properties';

export default function ERPropertyDrawer() {
  const { drawerOpen, drawerTableId, closeDrawer, tables } = useErDesignerStore();
  const [activeTab, setActiveTab] = useState<TabType>('columns');

  if (!drawerOpen || drawerTableId == null) return null;

  const table = tables.find(t => t.id === drawerTableId);
  if (!table) return null;

  return (
    <div className="w-[420px] shrink-0 bg-[var(--background-panel)] border-l border-[var(--border-strong)] flex flex-col h-full">
      {/* Title bar */}
      <div className="bg-[var(--background-hover)] px-3 py-2 flex items-center justify-between border-b border-[var(--border-strong)]">
        <span className="text-[13px] text-[var(--foreground-default)] font-medium truncate">{table.name}</span>
        <button onClick={closeDrawer} className="text-[var(--foreground-muted)] hover:text-[var(--foreground-default)]">
          <X size={14} />
        </button>
      </div>
      {/* Tab bar */}
      <div className="flex border-b border-[var(--border-strong)]">
        {(['columns', 'indexes', 'properties'] as TabType[]).map(tab => (
          <button
            key={tab}
            className={`px-4 py-2 text-[12px] transition-colors ${
              activeTab === tab
                ? 'text-[var(--accent)] border-b-2 border-[var(--accent)]'
                : 'text-[var(--foreground-subtle)] hover:text-[var(--foreground-muted)]'
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'columns' ? '列' : tab === 'indexes' ? '索引' : '表属性'}
          </button>
        ))}
      </div>
      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'columns' && <ColumnsTab tableId={drawerTableId} />}
        {activeTab === 'indexes' && <IndexesTab tableId={drawerTableId} tableName={table.name} />}
        {activeTab === 'properties' && <TablePropertiesTab tableId={drawerTableId} />}
      </div>
    </div>
  );
}
