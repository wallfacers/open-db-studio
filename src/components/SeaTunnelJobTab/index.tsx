import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Play, Square, Save, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useConfirmStore } from '../../store/confirmStore';
import { useSeaTunnelStore } from '../../store/seaTunnelStore';
import { useQueryStore } from '../../store/queryStore';
import type { Tab } from '../../types';
import type { ToastLevel } from '../Toast';
import VisualBuilder, {
  type BuilderState,
  builderStateToConfig,
  configToBuilderState,
} from './VisualBuilder';
import JsonEditor from './JsonEditor';
import JobLogPanel, { type JobLogPanelHandle } from './JobLogPanel';
import { useUIObjectRegistry } from '../../mcp/ui/useUIObjectRegistry';
import { SeaTunnelJobUIObject } from '../../mcp/ui/adapters/SeaTunnelJobAdapter';
import { useSeaTunnelJobFormStore } from '../../store/seatunnelJobStore';
import { useHighlightStore } from '../../store/highlightStore';
import { stJobNodeId } from '../../utils/nodeId';

// ─── Types ────────────────────────────────────────────────────────────────────

type Mode = 'visual' | 'script';
type RunStatus = 'idle' | 'RUNNING' | 'FINISHED' | 'FAILED' | 'CANCELLED';

interface StJob {
  id: number;
  name: string;
  category_id: number | null;
  connection_id: number | null;
  config_json: string | null;
  last_job_id: string | null;
  last_status: string | null;
  submitted_at: string | null;
}

interface StConnection {
  id: number;
  name: string;
  url: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG_JSON = JSON.stringify(
  {
    env: { 'job.name': 'new-job', parallelism: 1 },
    source: [{ plugin_name: 'MySQL', url: '', driver: '', user: '' }],
    transform: [],
    sink: [{ plugin_name: 'Console' }],
  },
  null,
  2
);

const DEFAULT_BUILDER_STATE: BuilderState = {
  env: { jobName: 'new-job', parallelism: 1 },
  source: { type: 'MySQL', fields: {} },
  transforms: [],
  sink: { type: 'Console', fields: {} },
};

function statusColor(status: RunStatus): string {
  switch (status) {
    case 'RUNNING':   return 'text-accent';
    case 'FINISHED':  return 'text-success';
    case 'FAILED':    return 'text-error';
    case 'CANCELLED': return 'text-warning';
    default:          return 'text-foreground-muted';
  }
}

function statusDot(status: RunStatus): string {
  switch (status) {
    case 'RUNNING':   return 'bg-accent animate-pulse';
    case 'FINISHED':  return 'bg-success';
    case 'FAILED':    return 'bg-error';
    case 'CANCELLED': return 'bg-warning';
    default:          return 'bg-foreground-muted';
  }
}

function statusLabel(status: RunStatus): string {
  switch (status) {
    case 'RUNNING':   return 'RUNNING';
    case 'FINISHED':  return 'FINISHED';
    case 'FAILED':    return 'FAILED';
    case 'CANCELLED': return 'CANCELLED';
    default:          return 'IDLE';
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

interface SeaTunnelJobTabProps {
  tab: Tab;
  showToast?: (msg: string, level?: ToastLevel) => void;
}

const SeaTunnelJobTab: React.FC<SeaTunnelJobTabProps> = ({ tab, showToast }) => {
  const { t } = useTranslation();
  const jobId = tab.stJobId;
  const { confirm } = useConfirmStore();
  const { updateJobStatus, updateJobLabel, setStJobContent } = useSeaTunnelStore();
  // 订阅外部（AI）写入的 configJson；用 ref 区分组件自身写入 vs 外部写入，防止循环
  const externalContent = useSeaTunnelStore(s => jobId ? s.stJobContent.get(jobId) : undefined);
  const lastSyncedContentRef = useRef<string>('');
  const updateSeaTunnelJobTabTitle = useQueryStore(s => s.updateSeaTunnelJobTabTitle);
  // 订阅树节点 label，响应从树侧发起的重命名
  const nodeLabel = useSeaTunnelStore(s => jobId ? s.nodes.get(stJobNodeId(jobId))?.label : undefined);

  const tabId = tab.id;

  // ── Init / cleanup form store for UIObject ──────────────────────────────
  useEffect(() => {
    useSeaTunnelJobFormStore.getState().initForm(tabId, {
      jobId: tab.stJobId ?? undefined,
      jobName: '',
      configJson: '',
      connectionId: tab.stConnectionId ?? undefined,
    });
    return () => useSeaTunnelJobFormStore.getState().removeForm(tabId);
  }, [tabId]);

  // ── Cleanup highlights on unmount ─────────────────────────────
  useEffect(() => {
    return () => useHighlightStore.getState().clearAll(tabId);
  }, [tabId]);

  // Job metadata
  const [jobName, setJobName] = useState('');
  const [connections, setConnections] = useState<StConnection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<number | null>(
    tab.stConnectionId ?? null
  );

  // Editor state
  const [mode, setMode] = useState<Mode>('visual');
  const [configJson, setConfigJson] = useState(DEFAULT_CONFIG_JSON);
  const [builderState, setBuilderState] = useState<BuilderState>(DEFAULT_BUILDER_STATE);

  // Run state
  const [runningStatus, setRunningStatus] = useState<RunStatus>('idle');
  const [seaTunnelJobId, setSeaTunnelJobId] = useState<string | null>(null);

  // UI
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const logPanelRef = useRef<JobLogPanelHandle>(null);

  // ── Load job info ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!jobId) return;
    (async () => {
      try {
        const [jobs, conns] = await Promise.all([
          invoke<StJob[]>('list_st_jobs'),
          invoke<StConnection[]>('list_st_connections'),
        ]);
        setConnections(conns);

        const job = jobs.find((j) => j.id === jobId);
        if (!job) return;

        setJobName(job.name);
        if (job.connection_id) setSelectedConnectionId(job.connection_id);
        if (job.last_job_id) setSeaTunnelJobId(job.last_job_id);

        // 如果上次状态是 RUNNING，向 SeaTunnel 查询实际状态（防止重启后状态卡在 RUNNING）
        if (job.last_status === 'RUNNING' && job.last_job_id) {
          try {
            const actualStatus = await invoke<string>('get_st_job_status', { jobId: job.last_job_id });
            const resolved = (['FINISHED', 'FAILED', 'CANCELLED', 'RUNNING'] as string[]).includes(actualStatus)
              ? actualStatus as RunStatus
              : 'idle';
            setRunningStatus(resolved);
            if (jobId) updateJobStatus(jobId, resolved);
          } catch {
            // SeaTunnel 不可用，重置为 idle
            setRunningStatus('idle');
            if (jobId) updateJobStatus(jobId, 'idle');
          }
        } else if (job.last_status) {
          setRunningStatus(job.last_status as RunStatus);
        }

        const json = job.config_json ?? DEFAULT_CONFIG_JSON;
        const parsed = configToBuilderState(json) ?? { ...DEFAULT_BUILDER_STATE };
        // 统一用树节点名称作为 env.job.name
        parsed.env.jobName = job.name;
        setBuilderState(parsed);
        const finalJson = builderStateToConfig(parsed);
        setConfigJson(finalJson);
        // 同步到 store，供 MCP bridge 读取
        lastSyncedContentRef.current = finalJson;
        setStJobContent(jobId, finalJson);

        // 同步到 form store，供 SeaTunnelJobUIObject 读取
        useSeaTunnelJobFormStore.getState().setForm(tabId, {
          jobId: tab.stJobId ?? undefined,
          jobName: job.name,
          configJson: finalJson,
          connectionId: tab.stConnectionId ?? undefined,
        });
      } catch (e) {
        showToast?.(String(e), 'error');
      }
    })();
  }, [jobId]);

  // ── Register UIObject with UIRouter ────────────────────────────────────
  const jobUIObject = useMemo(() => {
    return new SeaTunnelJobUIObject(tabId);
  }, [tabId]);
  useUIObjectRegistry(jobUIObject);

  // ── 响应树侧重命名（inline edit）→ 同步 toolbar 输入框 ──────────────────
  useEffect(() => {
    if (!nodeLabel || nodeLabel === jobName) return;
    setJobName(nodeLabel);
    setBuilderState(prev => {
      const next = { ...prev, env: { ...prev.env, jobName: nodeLabel } };
      setConfigJson(builderStateToConfig(next));
      return next;
    });
  }, [nodeLabel]);

  // ── 外部（AI）写入 configJson 时同步到本地编辑器 ──────────────────────
  useEffect(() => {
    if (!jobId || externalContent === undefined) return;
    // 跳过自身写入触发的订阅，避免循环
    if (externalContent === lastSyncedContentRef.current) return;
    lastSyncedContentRef.current = externalContent;
    setConfigJson(externalContent);
    const parsed = configToBuilderState(externalContent);
    if (parsed) setBuilderState(parsed);
  }, [externalContent, jobId]);

  // ── Job name change：同步写入 builderState.env.jobName ───────────────────
  const handleJobNameChange = useCallback((name: string) => {
    setJobName(name);
    setBuilderState(prev => {
      const next = { ...prev, env: { ...prev.env, jobName: name } };
      setConfigJson(builderStateToConfig(next));
      return next;
    });
  }, []);

  // ── Sync builder ↔ JSON ───────────────────────────────────────────────────
  const handleBuilderChange = useCallback((state: BuilderState) => {
    setBuilderState(state);
    const json = builderStateToConfig(state);
    setConfigJson(json);
    if (jobId) { lastSyncedContentRef.current = json; setStJobContent(jobId, json); }
  }, [jobId, setStJobContent]);

  const handleJsonChange = useCallback((json: string) => {
    setConfigJson(json);
    const parsed = configToBuilderState(json);
    if (parsed) setBuilderState(parsed);
    if (jobId) { lastSyncedContentRef.current = json; setStJobContent(jobId, json); }
  }, [jobId, setStJobContent]);

  // ── Mode switch ───────────────────────────────────────────────────────────
  const switchMode = useCallback(
    async (next: Mode) => {
      if (next === mode) return;

      if (next === 'visual') {
        // Check for unknown fields
        try {
          const obj = JSON.parse(configJson) as Record<string, unknown>;
          const knownTopKeys = new Set(['env', 'source', 'transform', 'sink']);
          const hasUnknown = Object.keys(obj).some((k) => !knownTopKeys.has(k));
          if (hasUnknown) {
            const ok = await confirm({
              title: t('seaTunnelJob.mode.switchTitle'),
              message: t('seaTunnelJob.mode.switchMessage'),
              variant: 'danger',
              confirmLabel: t('seaTunnelJob.mode.continueSwitch'),
              cancelLabel: t('seaTunnelJob.mode.cancel'),
            });
            if (!ok) return;
          }
        } catch {
          // malformed JSON — let visual mode handle gracefully
        }
        const parsed = configToBuilderState(configJson);
        if (parsed) setBuilderState(parsed);
      } else {
        // script mode — sync json from builder
        setConfigJson(builderStateToConfig(builderState));
      }
      setMode(next);
    },
    [mode, configJson, builderState, confirm, t]
  );

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!jobId) return;
    setSaving(true);
    try {
      await invoke('update_st_job', {
        id: jobId,
        name: jobName,
        categoryId: null,
        connectionId: selectedConnectionId,
        configJson,
      });
      // 同步树节点 label 和 tab 标题
      updateJobLabel(jobId, jobName);
      updateSeaTunnelJobTabTitle(jobId, jobName);
      showToast?.(t('seaTunnelJob.toolbar.saveSuccess'), 'success');
    } catch (e) {
      showToast?.(String(e), 'error');
    } finally {
      setSaving(false);
    }
  }, [jobId, jobName, selectedConnectionId, configJson, updateJobLabel, updateSeaTunnelJobTabTitle]);

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!jobId) return;
    setSubmitting(true);
    logPanelRef.current?.appendLog(`[INFO] Submitting job "${jobName}"...`);
    try {
      // 1. Save first
      await invoke('update_st_job', {
        id: jobId,
        name: jobName,
        categoryId: null,
        connectionId: selectedConnectionId,
        configJson,
      });

      // 2. Submit
      const stJobId = await invoke<string>('submit_st_job', { jobId });
      setSeaTunnelJobId(stJobId);
      setRunningStatus('RUNNING');
      updateJobStatus(jobId, 'RUNNING');
      logPanelRef.current?.appendLog(`[INFO] Job submitted, id=${stJobId}`);

      // 3. Start log stream
      const connId = selectedConnectionId;
      if (connId) {
        await invoke('stream_st_job_logs', { connectionId: connId, jobId: stJobId });
      }
    } catch (e) {
      const msg = String(e);
      setRunningStatus('FAILED');
      updateJobStatus(jobId, 'FAILED');
      logPanelRef.current?.appendLog(`[ERROR] Submit failed: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }, [jobId, jobName, selectedConnectionId, configJson, updateJobStatus]);

  // ── Stop ──────────────────────────────────────────────────────────────────
  const handleStop = useCallback(async () => {
    if (!jobId) return;
    try {
      await invoke('stop_st_job', { jobId });           // 内部 DB job ID (i64)
      if (seaTunnelJobId) {
        await invoke('cancel_st_job_stream', { jobId: seaTunnelJobId }).catch(() => {});
      }
      setRunningStatus('CANCELLED');
      updateJobStatus(jobId, 'CANCELLED');
    } catch (e) {
      logPanelRef.current?.appendLog(`[ERROR] Stop failed: ${String(e)}`);
    }
  }, [seaTunnelJobId, jobId, updateJobStatus]);

  // ── Status change from log panel ─────────────────────────────────────────
  const handleStatusChange = useCallback(
    (status: string) => {
      setRunningStatus(status as RunStatus);
      if (jobId) updateJobStatus(jobId, status);
    },
    [jobId, updateJobStatus]
  );

  const isRunning = runningStatus === 'RUNNING';

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-background-base overflow-hidden">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 px-3 py-2 bg-background-panel border-b border-border-strong flex-shrink-0">
        {/* Job name */}
        <input
          type="text"
          value={jobName}
          onChange={(e) => handleJobNameChange(e.target.value)}
          placeholder={t('seaTunnelJob.toolbar.jobNamePlaceholder')}
          className="bg-background-base border border-border-strong rounded px-2.5 py-1 text-xs text-foreground-default placeholder-foreground-muted/50 focus:outline-none focus:border-accent/60 transition-colors w-52"
        />

        {/* Connection - read only */}
        <div className="flex items-center gap-1.5 px-2.5 py-1 bg-background-base border border-border-strong rounded text-xs text-foreground-muted select-none">
          <span className="text-foreground-muted">{t('seaTunnelJob.toolbar.clusterConnection').replace('-- ', '').replace(' --', '')}:</span>
          <span className="text-foreground-default">
            {connections.find(c => c.id === selectedConnectionId)?.name ?? '—'}
          </span>
        </div>

        {/* Status badge */}
        <div className="flex items-center gap-1.5 ml-1">
          <span className={`w-2 h-2 rounded-full inline-block ${statusDot(runningStatus)}`} />
          <span className={`text-[10px] font-medium ${statusColor(runningStatus)}`}>
            {statusLabel(runningStatus)}
          </span>
        </div>

        <div className="flex-1" />

        {/* Submit / Stop */}
        {isRunning ? (
          <button
            onClick={handleStop}
            className="flex items-center gap-1.5 px-3 py-1 text-xs text-foreground bg-error/80 hover:bg-error rounded transition-colors"
          >
            <Square size={12} />
            {t('seaTunnelJob.toolbar.stop')}
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={submitting || !selectedConnectionId}
            className="flex items-center gap-1.5 px-3 py-1 text-xs text-foreground bg-accent hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors"
          >
            {submitting ? (
              <RefreshCw size={12} className="animate-spin" />
            ) : (
              <Play size={12} />
            )}
            {t('seaTunnelJob.toolbar.submit')}
          </button>
        )}

        {/* Save */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1 text-xs text-foreground-default border border-border-strong hover:border-accent/60 hover:text-accent disabled:opacity-50 rounded transition-colors"
        >
          {saving ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />}
          {t('seaTunnelJob.toolbar.save')}
        </button>
      </div>

      {/* ── Mode switch ── */}
      <div className="flex items-center gap-1 px-3 py-1.5 bg-background-panel border-b border-border-strong flex-shrink-0">
        <button
          onClick={() => switchMode('visual')}
          className={`px-3 py-1 text-xs rounded transition-colors ${
            mode === 'visual'
              ? 'bg-background-hover text-accent border border-accent/40'
              : 'text-foreground-muted hover:text-foreground-default hover:bg-background-hover'
          }`}
        >
          {t('seaTunnelJob.mode.visual')}
        </button>
        <button
          onClick={() => switchMode('script')}
          className={`px-3 py-1 text-xs rounded transition-colors ${
            mode === 'script'
              ? 'bg-background-hover text-accent border border-accent/40'
              : 'text-foreground-muted hover:text-foreground-default hover:bg-background-hover'
          }`}
        >
          {t('seaTunnelJob.mode.script')}
        </button>
      </div>

      {/* ── Editor area ── */}
      <div className="flex-1 overflow-hidden">
        {mode === 'visual' ? (
          <VisualBuilder value={builderState} onChange={handleBuilderChange} scopeId={tabId} />
        ) : (
          <JsonEditor value={configJson} onChange={handleJsonChange} externalValue={externalContent} />
        )}
      </div>

      {/* ── Log panel ── */}
      <JobLogPanel
        ref={logPanelRef}
        jobId={isRunning ? seaTunnelJobId : null}
        onStatusChange={handleStatusChange}
      />
    </div>
  );
};

export default SeaTunnelJobTab;
