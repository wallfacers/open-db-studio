import React from 'react';
import { ChevronDown } from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ConnectorType =
  | 'MySQL'
  | 'PostgreSQL'
  | 'SQLServer'
  | 'Oracle'
  | 'FileCSV'
  | 'FileJSON'
  | 'Console';

export interface ConnectorField {
  key: string;
  label: string;
  required: boolean;
  type: 'text' | 'password' | 'number' | 'select';
  options?: string[];
}

const DB_FIELDS: ConnectorField[] = [
  { key: 'url',      label: 'JDBC URL', required: true,  type: 'text' },
  { key: 'driver',   label: 'Driver',   required: true,  type: 'text' },
  { key: 'user',     label: '用户名',   required: true,  type: 'text' },
  { key: 'password', label: '密码',     required: false, type: 'password' },
  { key: 'query',    label: 'SQL Query',required: false, type: 'text' },
  { key: 'database', label: 'Database', required: false, type: 'text' },
  { key: 'table',    label: 'Table',    required: false, type: 'text' },
];

export const CONNECTOR_FIELDS: Record<ConnectorType, ConnectorField[]> = {
  MySQL:      DB_FIELDS,
  PostgreSQL: DB_FIELDS,
  SQLServer:  DB_FIELDS,
  Oracle:     DB_FIELDS,
  FileCSV: [
    { key: 'path',       label: '文件路径', required: true,  type: 'text' },
    { key: 'delimiter',  label: '分隔符',   required: false, type: 'text' },
    { key: 'has_header', label: '包含表头', required: false, type: 'select', options: ['true', 'false'] },
  ],
  FileJSON: [
    { key: 'path', label: '文件路径', required: true, type: 'text' },
  ],
  Console: [],
};

const CONNECTOR_TYPES: ConnectorType[] = [
  'MySQL', 'PostgreSQL', 'SQLServer', 'Oracle', 'FileCSV', 'FileJSON', 'Console',
];

export type TransformType = 'FieldMapper' | 'Filter' | 'ReplaceString';

const TRANSFORM_FIELDS: Record<TransformType, ConnectorField[]> = {
  FieldMapper: [
    { key: 'field_mapper', label: 'Field Mapper (JSON)', required: false, type: 'text' },
  ],
  Filter: [
    { key: 'fields', label: '保留字段 (逗号分隔)', required: false, type: 'text' },
  ],
  ReplaceString: [
    { key: 'replace_string', label: 'Replace String (JSON)', required: false, type: 'text' },
  ],
};

const TRANSFORM_TYPES: TransformType[] = ['FieldMapper', 'Filter', 'ReplaceString'];

export interface ConnectorConfig {
  type: ConnectorType;
  fields: Record<string, string>;
}

export interface TransformConfig {
  type: TransformType;
  fields: Record<string, string>;
}

export interface EnvConfig {
  jobName: string;
  parallelism: number;
}

export interface BuilderState {
  env: EnvConfig;
  source: ConnectorConfig;
  transforms: TransformConfig[];
  sink: ConnectorConfig;
}

// ─── Serialization ────────────────────────────────────────────────────────────

export function builderStateToConfig(state: BuilderState): string {
  const obj: Record<string, unknown> = {
    env: {
      'job.name': state.env.jobName || 'unnamed-job',
      parallelism: state.env.parallelism || 1,
    },
    source: [
      {
        plugin_name: state.source.type,
        ...state.source.fields,
      },
    ],
    transform: state.transforms.map((t) => ({
      plugin_name: t.type,
      ...t.fields,
    })),
    sink: [
      {
        plugin_name: state.sink.type,
        ...state.sink.fields,
      },
    ],
  };
  return JSON.stringify(obj, null, 2);
}

export function configToBuilderState(json: string): BuilderState | null {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;

    const envRaw = (obj.env ?? {}) as Record<string, unknown>;
    const env: EnvConfig = {
      jobName: String(envRaw['job.name'] ?? ''),
      parallelism: Number(envRaw.parallelism ?? 1),
    };

    const sourceArr = Array.isArray(obj.source) ? obj.source : [];
    const sourceRaw = (sourceArr[0] ?? {}) as Record<string, unknown>;
    const { plugin_name: srcType, ...srcFields } = sourceRaw;
    const source: ConnectorConfig = {
      type: (srcType as ConnectorType) || 'MySQL',
      fields: Object.fromEntries(
        Object.entries(srcFields).map(([k, v]) => [k, String(v ?? '')])
      ),
    };

    const transformArr = Array.isArray(obj.transform) ? obj.transform : [];
    const transforms: TransformConfig[] = transformArr.map((t) => {
      const { plugin_name: tType, ...tFields } = t as Record<string, unknown>;
      return {
        type: (tType as TransformType) || 'FieldMapper',
        fields: Object.fromEntries(
          Object.entries(tFields).map(([k, v]) => [k, String(v ?? '')])
        ),
      };
    });

    const sinkArr = Array.isArray(obj.sink) ? obj.sink : [];
    const sinkRaw = (sinkArr[0] ?? {}) as Record<string, unknown>;
    const { plugin_name: sinkType, ...sinkFields } = sinkRaw;
    const sink: ConnectorConfig = {
      type: (sinkType as ConnectorType) || 'Console',
      fields: Object.fromEntries(
        Object.entries(sinkFields).map(([k, v]) => [k, String(v ?? '')])
      ),
    };

    return { env, source, transforms, sink };
  } catch {
    return null;
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const inputCls =
  'w-full bg-[#0d1117] border border-[#253347] rounded px-2.5 py-1.5 text-xs text-[#c8daea] ' +
  'placeholder-[#7a9bb8]/50 focus:outline-none focus:border-[#00c9a7]/60 transition-colors';

const labelCls = 'text-[10px] font-medium text-[#7a9bb8] uppercase tracking-wide';

interface FieldInputProps {
  field: ConnectorField;
  value: string;
  onChange: (v: string) => void;
}

const FieldInput: React.FC<FieldInputProps> = ({ field, value, onChange }) => {
  if (field.type === 'select' && field.options) {
    return (
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputCls} appearance-none pr-7 cursor-pointer`}
        >
          <option value="">-- 请选择 --</option>
          {field.options.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
        <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#7a9bb8] pointer-events-none" />
      </div>
    );
  }

  return (
    <input
      type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.required ? `${field.label} (必填)` : field.label}
      className={inputCls}
    />
  );
};

interface ConnectorPanelProps {
  title: string;
  config: ConnectorConfig;
  onChange: (config: ConnectorConfig) => void;
}

const ConnectorPanel: React.FC<ConnectorPanelProps> = ({ title, config, onChange }) => {
  const fields = CONNECTOR_FIELDS[config.type] ?? [];

  const handleTypeChange = (type: ConnectorType) => {
    onChange({ type, fields: {} });
  };

  const handleFieldChange = (key: string, value: string) => {
    onChange({ ...config, fields: { ...config.fields, [key]: value } });
  };

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="text-[11px] font-semibold text-[#00c9a7] uppercase tracking-wider pb-1 border-b border-[#253347]">
        {title}
      </div>

      {/* Connector type selector */}
      <div className="flex flex-col gap-1">
        <span className={labelCls}>类型</span>
        <div className="relative">
          <select
            value={config.type}
            onChange={(e) => handleTypeChange(e.target.value as ConnectorType)}
            className={`${inputCls} appearance-none pr-7 cursor-pointer`}
          >
            {CONNECTOR_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#7a9bb8] pointer-events-none" />
        </div>
      </div>

      {/* Dynamic fields */}
      <div className="flex flex-col gap-2.5 overflow-y-auto flex-1 pr-0.5">
        {fields.length === 0 && (
          <p className="text-xs text-[#7a9bb8] italic mt-2">无需额外配置</p>
        )}
        {fields.map((field) => (
          <div key={field.key} className="flex flex-col gap-1">
            <span className={labelCls}>
              {field.label}
              {field.required && <span className="text-red-400 ml-0.5">*</span>}
            </span>
            <FieldInput
              field={field}
              value={config.fields[field.key] ?? ''}
              onChange={(v) => handleFieldChange(field.key, v)}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

interface TransformPanelProps {
  transforms: TransformConfig[];
  onChange: (transforms: TransformConfig[]) => void;
}

const TransformPanel: React.FC<TransformPanelProps> = ({ transforms, onChange }) => {
  const addTransform = () => {
    onChange([...transforms, { type: 'FieldMapper', fields: {} }]);
  };

  const removeTransform = (idx: number) => {
    onChange(transforms.filter((_, i) => i !== idx));
  };

  const updateTransform = (idx: number, t: TransformConfig) => {
    const next = [...transforms];
    next[idx] = t;
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex items-center justify-between pb-1 border-b border-[#253347]">
        <span className="text-[11px] font-semibold text-[#00c9a7] uppercase tracking-wider">
          Transform
        </span>
        <button
          onClick={addTransform}
          className="text-[10px] text-[#00c9a7] hover:text-white px-2 py-0.5 rounded border border-[#253347] hover:border-[#00c9a7]/60 transition-colors"
        >
          + 添加
        </button>
      </div>

      <div className="flex flex-col gap-3 overflow-y-auto flex-1 pr-0.5">
        {transforms.length === 0 && (
          <p className="text-xs text-[#7a9bb8] italic mt-2">无转换步骤（可选）</p>
        )}
        {transforms.map((t, idx) => {
          const fields = TRANSFORM_FIELDS[t.type] ?? [];
          return (
            <div key={idx} className="bg-[#0d1117] border border-[#253347] rounded p-2.5 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="relative flex-1 mr-2">
                  <select
                    value={t.type}
                    onChange={(e) =>
                      updateTransform(idx, { type: e.target.value as TransformType, fields: {} })
                    }
                    className={`${inputCls} appearance-none pr-7 cursor-pointer`}
                  >
                    {TRANSFORM_TYPES.map((tt) => (
                      <option key={tt} value={tt}>{tt}</option>
                    ))}
                  </select>
                  <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#7a9bb8] pointer-events-none" />
                </div>
                <button
                  onClick={() => removeTransform(idx)}
                  className="text-[#7a9bb8] hover:text-red-400 transition-colors text-xs px-1"
                  title="删除"
                >
                  ✕
                </button>
              </div>
              {fields.map((f) => (
                <div key={f.key} className="flex flex-col gap-1">
                  <span className={labelCls}>{f.label}</span>
                  <FieldInput
                    field={f}
                    value={t.fields[f.key] ?? ''}
                    onChange={(v) =>
                      updateTransform(idx, { ...t, fields: { ...t.fields, [f.key]: v } })
                    }
                  />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────

interface VisualBuilderProps {
  value: BuilderState;
  onChange: (state: BuilderState) => void;
}

const VisualBuilder: React.FC<VisualBuilderProps> = ({ value, onChange }) => {
  return (
    <div className="flex flex-col h-full gap-0">
      {/* Env bar */}
      <div className="flex items-center gap-4 px-3 py-2 bg-[#0d1117] border-b border-[#253347] flex-shrink-0">
        <span className={`${labelCls} whitespace-nowrap`}>Job 名称</span>
        <input
          type="text"
          value={value.env.jobName}
          onChange={(e) => onChange({ ...value, env: { ...value.env, jobName: e.target.value } })}
          placeholder="unnamed-job"
          className={`${inputCls} flex-1`}
        />
        <span className={`${labelCls} whitespace-nowrap`}>并行度</span>
        <input
          type="number"
          min={1}
          value={value.env.parallelism}
          onChange={(e) =>
            onChange({ ...value, env: { ...value.env, parallelism: parseInt(e.target.value, 10) || 1 } })
          }
          className={`${inputCls} w-20`}
        />
      </div>

      {/* Three-column layout */}
      <div className="flex flex-1 overflow-hidden divide-x divide-[#253347]">
        {/* Source */}
        <div className="flex-1 p-3 overflow-hidden flex flex-col">
          <ConnectorPanel
            title="Source"
            config={value.source}
            onChange={(source) => onChange({ ...value, source })}
          />
        </div>

        {/* Transform */}
        <div className="flex-1 p-3 overflow-hidden flex flex-col">
          <TransformPanel
            transforms={value.transforms}
            onChange={(transforms) => onChange({ ...value, transforms })}
          />
        </div>

        {/* Sink */}
        <div className="flex-1 p-3 overflow-hidden flex flex-col">
          <ConnectorPanel
            title="Sink"
            config={value.sink}
            onChange={(sink) => onChange({ ...value, sink })}
          />
        </div>
      </div>
    </div>
  );
};

export default VisualBuilder;
