import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { ChevronDown, Trash2, ArrowDownToLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '../common/Tooltip';

interface LogLine {
  ts: string;
  text: string;
}

interface JobLogPanelProps {
  jobId: string | null;
  onStatusChange: (status: string) => void;
  onClear?: () => void;
}

export interface JobLogPanelHandle {
  appendLog: (text: string) => void;
}

const JobLogPanel = forwardRef<JobLogPanelHandle, JobLogPanelProps>(({ jobId, onStatusChange, onClear }, ref) => {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [panelHeight, setPanelHeight] = useState(200);
  const bottomRef = useRef<HTMLDivElement>(null);

  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = panelHeight;

    const onMouseMove = (me: MouseEvent) => {
      const delta = startY - me.clientY;
      const newHeight = Math.max(80, Math.min(600, startHeight + delta));
      setPanelHeight(newHeight);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const appendLog = useCallback((text: string) => {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setLogs((prev) => [...prev, { ts, text }]);
    setCollapsed(false);
  }, []);

  useImperativeHandle(ref, () => ({ appendLog }), [appendLog]);

  // Auto scroll
  useEffect(() => {
    if (autoScroll && !collapsed) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll, collapsed]);

  // Listen events
  useEffect(() => {
    if (!jobId) return;

    let pollingTimer: ReturnType<typeof setInterval> | null = null;

    const unlistenPromises = [
      // Log lines
      listen<{ job_id: string; line: string }>('st_job_log', ({ payload }) => {
        if (payload.job_id !== jobId) return;
        appendLog(payload.line);
      }),

      // Job finished (status: FINISHED / FAILED / CANCELLED)
      listen<{ job_id: string; status: string }>('st_job_finished', ({ payload }) => {
        if (payload.job_id !== jobId) return;
        onStatusChange(payload.status);
      }),

      // Stream error → fallback polling
      listen<{ job_id: string; reason: string }>('st_job_stream_error', ({ payload }) => {
        if (payload.job_id !== jobId) return;
        appendLog(t('seaTunnelJob.jobLogPanel.logStreamInterrupted', { reason: payload.reason }));

        if (pollingTimer) clearInterval(pollingTimer);
        pollingTimer = setInterval(async () => {
          try {
            const status = await invoke<string>('get_st_job_status', { jobId });
            if (['FINISHED', 'FAILED', 'CANCELLED'].includes(status)) {
              if (pollingTimer) clearInterval(pollingTimer);
              pollingTimer = null;
              appendLog(t('seaTunnelJob.jobLogPanel.pollingResult', { status }));
              onStatusChange(status);
            }
          } catch (e) {
            appendLog(t('seaTunnelJob.jobLogPanel.pollingFailed', { error: String(e) }));
          }
        }, 10_000);
      }),
    ];

    return () => {
      if (pollingTimer) clearInterval(pollingTimer);
      Promise.all(unlistenPromises).then((unlisteners) => {
        unlisteners.forEach((fn) => fn());
      });
    };
  }, [jobId, appendLog, onStatusChange, t]);

  const handleClear = () => {
    setLogs([]);
    onClear?.();
  };

  return (
    <div
      className="flex flex-col flex-shrink-0 border-t border-[var(--border-strong)] bg-[var(--background-base)]"
      style={{ height: collapsed ? 'auto' : `${panelHeight}px` }}
    >
      {/* Resize handle */}
      {!collapsed && (
        <div
          className="h-1 cursor-ns-resize hover:bg-[var(--accent)]/50 flex-shrink-0 transition-colors"
          onMouseDown={handleResizeMouseDown}
        />
      )}
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--border-strong)] flex-shrink-0">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] transition-colors"
        >
          <ChevronDown
            size={13}
            className={`transition-transform ${collapsed ? '-rotate-90' : ''}`}
          />
          {t('seaTunnelJob.jobLogPanel.title')}
          {logs.length > 0 && (
            <span className="text-[10px] bg-[var(--background-hover)] text-[var(--foreground-muted)] px-1.5 py-0.5 rounded-full">
              {logs.length}
            </span>
          )}
        </button>

        <div className="flex items-center gap-1">
          <Tooltip content={t('seaTunnelJob.jobLogPanel.clearLog')} className="contents">
            <button
              onClick={handleClear}
              className="flex items-center gap-1 px-2 py-1 text-[10px] text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] hover:bg-[var(--background-hover)] rounded transition-colors"
            >
              <Trash2 size={11} />
              {t('seaTunnelJob.jobLogPanel.clear')}
            </button>
          </Tooltip>
          <Tooltip content={t('seaTunnelJob.jobLogPanel.scrollToBottom')} className="contents">
            <button
              onClick={() => {
                setAutoScroll(true);
                bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
              }}
              className={`flex items-center gap-1 px-2 py-1 text-[10px] rounded transition-colors ${
                autoScroll
                  ? 'text-[var(--accent)] bg-[var(--accent)]/10'
                  : 'text-[var(--foreground-muted)] hover:text-[var(--foreground-default)] hover:bg-[var(--background-hover)]'
              }`}
            >
              <ArrowDownToLine size={11} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Log content */}
      {!collapsed && (
        <div
          className="flex-1 overflow-y-auto p-2"
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
            setAutoScroll(atBottom);
          }}
        >
          {logs.length === 0 ? (
            <p className="text-[11px] text-[var(--foreground-muted)]/60 italic px-1 py-1">
              {jobId ? t('seaTunnelJob.jobLogPanel.waitingForLogs') : t('seaTunnelJob.jobLogPanel.logsWillAppear')}
            </p>
          ) : (
            <div className="font-mono text-[11px] leading-relaxed space-y-0.5">
              {logs.map((line, idx) => (
                <div key={idx} className="flex gap-2">
                  <span className="text-[var(--border-strong)] flex-shrink-0 select-none">{line.ts}</span>
                  <span className={getLogColor(line.text)}>{line.text}</span>
                </div>
              ))}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
});

function getLogColor(text: string): string {
  if (text.startsWith('[ERROR]')) return 'text-red-400';
  if (text.startsWith('[WARN]'))  return 'text-yellow-400';
  if (text.startsWith('[INFO]'))  return 'text-[var(--accent)]';
  return 'text-green-400';
}

export default JobLogPanel;
