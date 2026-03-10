import React, { useEffect } from 'react';
import { useQueryStore, useConnectionStore } from '../../store';

export function QueryHistory() {
  const { queryHistory, loadHistory, setSql, activeTabId } = useQueryStore();
  const { activeConnectionId } = useConnectionStore();

  useEffect(() => {
    if (activeConnectionId) loadHistory(activeConnectionId);
  }, [activeConnectionId]);

  if (!activeConnectionId) {
    return <div className="p-4 text-[#858585] text-sm">请先选择一个连接</div>;
  }

  return (
    <div className="h-full overflow-auto">
      {queryHistory.length === 0 ? (
        <div className="p-4 text-[#858585] text-sm">暂无查询历史</div>
      ) : (
        queryHistory.map((h) => (
          <div
            key={h.id}
            className="px-3 py-2 border-b border-[#2b2b2b] hover:bg-[#2a2a2a] cursor-pointer"
            onClick={() => setSql(activeTabId, h.sql)}
          >
            <div className="font-mono text-xs text-[#d4d4d4] truncate">{h.sql}</div>
            <div className="flex gap-2 mt-1 text-xs text-[#858585]">
              <span>{h.executed_at.slice(0, 19).replace('T', ' ')}</span>
              {h.duration_ms !== null && <span>{h.duration_ms}ms</span>}
              {h.row_count !== null && <span>{h.row_count} 行</span>}
              {h.error_msg && <span className="text-red-400 truncate">{h.error_msg}</span>}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
