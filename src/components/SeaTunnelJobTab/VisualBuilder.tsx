import React from 'react';
import { useTranslation } from 'react-i18next';
import { DropdownSelect } from '../common/DropdownSelect';

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
  { key: 'user',     label: 'username', required: true,  type: 'text' },
  { key: 'password', label: 'password', required: false, type: 'password' },
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
    { key: 'path',       label: 'filePath',  required: true,  type: 'text' },
    { key: 'delimiter',  label: 'delimiter', required: false, type: 'text' },
    { key: 'has_header', label: 'hasHeader', required: false, type: 'select', options: ['true', 'false'] },
  ],
  FileJSON: [
    { key: 'path', label: 'filePath', required: true, type: 'text' },
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
    { key: 'fields', label: 'keepFields', required: false, type: 'text' },
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

// ─── Connector → SeaTunnel plugin_name & driver mapping ──────────────────────

const JDBC_TYPES = new Set<ConnectorType>(['MySQL', 'PostgreSQL', 'SQLServer', 'Oracle']);

/** UI type → SeaTunnel plugin_name */
function toPluginName(type: ConnectorType): string {
  return JDBC_TYPES.has(type) ? 'Jdbc' : type === 'FileCSV' || type === 'FileJSON' ? 'LocalFile' : type;
}

/** UI type → default JDBC driver class */
export const DEFAULT_DRIVER: Partial<Record<ConnectorType, string>> = {
  MySQL:      'com.mysql.cj.jdbc.Driver',
  PostgreSQL: 'org.postgresql.Driver',
  SQLServer:  'com.microsoft.sqlserver.jdbc.SQLServerDriver',
  Oracle:     'oracle.jdbc.OracleDriver',
};

/** JDBC driver class → UI type (reverse lookup) */
function driverToType(driver: string): ConnectorType {
  if (driver.includes('mysql'))      return 'MySQL';
  if (driver.includes('postgresql')) return 'PostgreSQL';
  if (driver.includes('sqlserver'))  return 'SQLServer';
  if (driver.includes('oracle'))     return 'Oracle';
  return 'MySQL';
}

// ─── Serialization ────────────────────────────────────────────────────────────

export function builderStateToConfig(state: BuilderState): string {
  const buildConnector = (cfg: ConnectorConfig) => {
    const fields = { ...cfg.fields };
    // Auto-fill driver for JDBC types if not set
    if (JDBC_TYPES.has(cfg.type) && !fields.driver) {
      fields.driver = DEFAULT_DRIVER[cfg.type] ?? '';
    }
    return { plugin_name: toPluginName(cfg.type), ...fields };
  };

  const obj: Record<string, unknown> = {
    env: {
      'job.name': state.env.jobName || 'unnamed-job',
      parallelism: state.env.parallelism || 1,
    },
    source: [buildConnector(state.source)],
    transform: state.transforms.map((t) => ({
      plugin_name: t.type,
      ...t.fields,
    })),
    sink: [buildConnector(state.sink)],
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

    const parseConnector = (arr: unknown[], defaultType: ConnectorType): ConnectorConfig => {
      const raw = (Array.isArray(arr) ? arr[0] : {}) as Record<string, unknown>;
      const { plugin_name: pluginName, ...rest } = raw;
      const fields = Object.fromEntries(
        Object.entries(rest).map(([k, v]) => [k, String(v ?? '')])
      );
      let type: ConnectorType = defaultType;
      if (pluginName === 'Jdbc') {
        type = driverToType(String(fields.driver ?? ''));
      } else if (pluginName === 'LocalFile') {
        type = fields.path?.endsWith('.json') ? 'FileJSON' : 'FileCSV';
      } else if (pluginName) {
        type = pluginName as ConnectorType;
      }
      return { type, fields };
    };

    const source = parseConnector(Array.isArray(obj.source) ? obj.source : [], 'MySQL');

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

    const sink = parseConnector(Array.isArray(obj.sink) ? obj.sink : [], 'Console');

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
  t: (key: string, options?: Record<string, unknown>) => string;
}

const FieldInput: React.FC<FieldInputProps> = ({ field, value, onChange, t }) => {
  // Get translated label
  const getLabel = (labelKey: string): string => {
    const key = `seaTunnelJob.visualBuilder.${labelKey}`;
    const translated = t(key);
    // If translation doesn't exist, return the original label
    return translated === key ? labelKey : translated;
  };

  if (field.type === 'select' && field.options) {
    const options = field.options.map((opt) => ({ value: opt, label: opt }));
    return (
      <DropdownSelect
        value={value}
        options={options}
        placeholder={t('seaTunnelJob.visualBuilder.pleaseSelect')}
        onChange={onChange}
        className="w-full"
      />
    );
  }

  const label = getLabel(field.label);

  if (field.type === 'number') {
    const numVal = parseInt(value, 10) || 0;
    return (
      <div className="flex items-stretch border border-[#253347] rounded overflow-hidden focus-within:border-[#00c9a7]/60 transition-colors">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.required ? `${label} ${t('seaTunnelJob.visualBuilder.required')}` : label}
          className="flex-1 min-w-0 bg-[#0d1117] px-2.5 py-1.5 text-xs text-[#c8daea] placeholder-[#7a9bb8]/50 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <div className="flex flex-col border-l border-[#253347] bg-[#0d1117]">
          <button type="button" onClick={() => onChange(String(numVal + 1))}
            className="flex-1 flex items-center justify-center px-1.5 text-[#00c9a7] hover:text-[#29edd0] hover:bg-[#151d28] transition-colors border-b border-[#253347]">
            <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor"><path d="M4 0L8 5H0Z"/></svg>
          </button>
          <button type="button" onClick={() => onChange(String(Math.max(0, numVal - 1)))}
            className="flex-1 flex items-center justify-center px-1.5 text-[#00c9a7] hover:text-[#29edd0] hover:bg-[#151d28] transition-colors">
            <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor"><path d="M4 5L0 0H8Z"/></svg>
          </button>
        </div>
      </div>
    );
  }

  return (
    <input
      type={field.type === 'password' ? 'password' : 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.required ? `${label} ${t('seaTunnelJob.visualBuilder.required')}` : label}
      className={inputCls}
    />
  );
};

interface ConnectorPanelProps {
  title: string;
  config: ConnectorConfig;
  onChange: (config: ConnectorConfig) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

// Helper to translate label keys
const getTranslatedLabel = (labelKey: string, t: (key: string) => string): string => {
  const key = `seaTunnelJob.visualBuilder.${labelKey}`;
  const translated = t(key);
  return translated === key ? labelKey : translated;
};

const ConnectorPanel: React.FC<ConnectorPanelProps> = ({ title, config, onChange, t }) => {
  const fields = CONNECTOR_FIELDS[config.type] ?? [];

  const handleTypeChange = (type: ConnectorType) => {
    const fields: Record<string, string> = {};
    if (DEFAULT_DRIVER[type]) fields.driver = DEFAULT_DRIVER[type]!;
    onChange({ type, fields });
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
        <span className={labelCls}>{t('seaTunnelJob.visualBuilder.type')}</span>
        <DropdownSelect
          value={config.type}
          options={CONNECTOR_TYPES.map((ct) => ({ value: ct, label: ct }))}
          onChange={(v) => handleTypeChange(v as ConnectorType)}
          className="w-full"
        />
      </div>

      {/* Dynamic fields */}
      <div className="flex flex-col gap-2.5 overflow-y-auto flex-1 pr-0.5">
        {fields.length === 0 && (
          <p className="text-xs text-[#7a9bb8] italic mt-2">{t('seaTunnelJob.visualBuilder.noExtraConfig')}</p>
        )}
        {fields.map((field) => (
          <div key={field.key} className="flex flex-col gap-1">
            <span className={labelCls}>
              {getTranslatedLabel(field.label, t)}
              {field.required && <span className="text-red-400 ml-0.5">*</span>}
            </span>
            <FieldInput
              field={field}
              value={config.fields[field.key] ?? ''}
              onChange={(v) => handleFieldChange(field.key, v)}
              t={t}
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
  t: (key: string, options?: Record<string, unknown>) => string;
}

const TransformPanel: React.FC<TransformPanelProps> = ({ transforms, onChange, t }) => {
  const addTransform = () => {
    onChange([...transforms, { type: 'FieldMapper', fields: {} }]);
  };

  const removeTransform = (idx: number) => {
    onChange(transforms.filter((_, i) => i !== idx));
  };

  const updateTransform = (idx: number, tc: TransformConfig) => {
    const next = [...transforms];
    next[idx] = tc;
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
          {t('seaTunnelJob.visualBuilder.add')}
        </button>
      </div>

      <div className="flex flex-col gap-3 overflow-y-auto flex-1 pr-0.5">
        {transforms.length === 0 && (
          <p className="text-xs text-[#7a9bb8] italic mt-2">{t('seaTunnelJob.visualBuilder.noTransformSteps')}</p>
        )}
        {transforms.map((tr, idx) => {
          const fields = TRANSFORM_FIELDS[tr.type] ?? [];
          return (
            <div key={idx} className="bg-[#0d1117] border border-[#253347] rounded p-2.5 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <DropdownSelect
                  value={tr.type}
                  options={TRANSFORM_TYPES.map((tt) => ({ value: tt, label: tt }))}
                  onChange={(v) => updateTransform(idx, { type: v as TransformType, fields: {} })}
                  className="flex-1 mr-2"
                />
                <button
                  onClick={() => removeTransform(idx)}
                  className="text-[#7a9bb8] hover:text-red-400 transition-colors text-xs px-1"
                  title={t('seaTunnelJob.visualBuilder.remove')}
                >
                  ✕
                </button>
              </div>
              {fields.map((f) => (
                <div key={f.key} className="flex flex-col gap-1">
                  <span className={labelCls}>{getTranslatedLabel(f.label, t)}</span>
                  <FieldInput
                    field={f}
                    value={tr.fields[f.key] ?? ''}
                    onChange={(v) =>
                      updateTransform(idx, { ...tr, fields: { ...tr.fields, [f.key]: v } })
                    }
                    t={t}
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
  const { t } = useTranslation();

  return (
    <div className="flex flex-col h-full gap-0">
      {/* Env bar */}
      <div className="flex items-center gap-3 px-3 py-2 bg-[#0d1117] border-b border-[#253347] flex-shrink-0">
        <span className={`${labelCls} whitespace-nowrap`}>{t('seaTunnelJob.visualBuilder.parallelism')}</span>
        {/* 自定义数字步进器，避免原生 spinner 样式问题 */}
        <div className="flex items-stretch border border-[#253347] rounded overflow-hidden focus-within:border-[#00c9a7]/60 transition-colors" style={{ width: '80px' }}>
          <input
            type="number"
            min={1}
            value={value.env.parallelism}
            onChange={(e) =>
              onChange({ ...value, env: { ...value.env, parallelism: parseInt(e.target.value, 10) || 1 } })
            }
            className="flex-1 min-w-0 bg-[#0d1117] px-2 py-1.5 text-xs text-[#c8daea] focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <div className="flex flex-col border-l border-[#253347] bg-[#0d1117]">
            <button
              type="button"
              onClick={() => onChange({ ...value, env: { ...value.env, parallelism: value.env.parallelism + 1 } })}
              className="flex-1 flex items-center justify-center px-1.5 text-[#00c9a7] hover:text-[#29edd0] hover:bg-[#151d28] transition-colors border-b border-[#253347]"
            >
              <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor"><path d="M4 0L8 5H0Z"/></svg>
            </button>
            <button
              type="button"
              onClick={() => onChange({ ...value, env: { ...value.env, parallelism: Math.max(1, value.env.parallelism - 1) } })}
              className="flex-1 flex items-center justify-center px-1.5 text-[#00c9a7] hover:text-[#29edd0] hover:bg-[#151d28] transition-colors"
            >
              <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor"><path d="M4 5L0 0H8Z"/></svg>
            </button>
          </div>
        </div>
      </div>

      {/* Three-column layout */}
      <div className="flex flex-1 overflow-hidden divide-x divide-[#253347]">
        {/* Source */}
        <div className="flex-1 p-3 overflow-hidden flex flex-col">
          <ConnectorPanel
            title="Source"
            config={value.source}
            onChange={(source) => onChange({ ...value, source })}
            t={t}
          />
        </div>

        {/* Transform */}
        <div className="flex-1 p-3 overflow-hidden flex flex-col">
          <TransformPanel
            transforms={value.transforms}
            onChange={(transforms) => onChange({ ...value, transforms })}
            t={t}
          />
        </div>

        {/* Sink */}
        <div className="flex-1 p-3 overflow-hidden flex flex-col">
          <ConnectorPanel
            title="Sink"
            config={value.sink}
            onChange={(sink) => onChange({ ...value, sink })}
            t={t}
          />
        </div>
      </div>
    </div>
  );
};

export default VisualBuilder;
