import { useState, useRef, useEffect, useMemo } from 'react';
import { Handle, Position, useNodeConnections, useUpdateNodeInternals } from '@xyflow/react';
import { Key, Hash, X, TableProperties } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DropdownSelect } from '../../common/DropdownSelect';
import { Tooltip } from '../../common/Tooltip';
import { getTypeOptions, formatTypeDisplay, findTypeDef } from '../shared/dataTypes';
import type { DialectName } from '../shared/dataTypes';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import { resolveConstraintMethod } from '../shared/resolveConstraint';
import { useFieldHighlight } from '../../../hooks/useFieldHighlight';

interface ERTableNodeData {
  table: import('../../../types').ErTable;
  columns: import('../../../types').ErColumn[];
  highlightScopeId?: string;
  onUpdateTable: (updates: Partial<import('../../../types').ErTable>) => void;
  onAddColumn: () => void;
  onUpdateColumn: (colId: number, updates: Partial<import('../../../types').ErColumn>) => void;
  onDeleteColumn: (colId: number) => void;
  onDeleteTable: () => void;
}

export default function ERTableNode({ id, data }: { id: string; data: ERTableNodeData }) {
  const { t } = useTranslation();
  const { table, columns, highlightScopeId, onUpdateTable, onAddColumn, onUpdateColumn, onDeleteColumn, onDeleteTable } = data;
  const { boundDialect, relations, projects, activeProjectId } = useErDesignerStore();

  // Re-measure handle positions when columns reorder (node height stays same, ResizeObserver won't fire)
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, columns, updateNodeInternals]);

  // AI change highlight — whole table (e.g. new table added)
  const { className: tableHL } = useFieldHighlight(highlightScopeId ?? '', `table:${table.id}`)
  // AI change highlight — table name field
  const { className: nameHL } = useFieldHighlight(highlightScopeId ?? '', `table:${table.id}:name`)

  // 计算该表所有关系的多数派约束方式
  const project = projects.find(p => p.id === activeProjectId);
  const tableRelations = relations.filter(
    r => r.source_table_id === table.id || r.target_table_id === table.id
  );
  const majorityConstraintMethod = useMemo(() => {
    if (tableRelations.length === 0) return null;
    const counts: Record<string, number> = {};
    for (const rel of tableRelations) {
      const method = resolveConstraintMethod(rel, table, project);
      counts[method] = (counts[method] ?? 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }, [tableRelations, table.constraint_method, project?.default_constraint_method]);
  const typeOptions = useMemo(() => getTypeOptions(boundDialect as DialectName | null), [boundDialect]);

  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(table.name);

  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, [isEditingName]);

  const dispatchContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('er-table-context-menu', {
      detail: { tableId: table.id, x: e.clientX, y: e.clientY },
    }));
  };

  const handleNameSave = () => {
    setIsEditingName(false);
    if (editName.trim() && editName !== table.name) {
      onUpdateTable({ name: editName.trim() });
    } else {
      setEditName(table.name);
    }
  };

  const ColumnRow = ({ col }: { col: typeof columns[number] }) => {
    const { t } = useTranslation();
    const [isEditingName, setIsEditingName] = useState(false);
    const [editName, setEditName] = useState(col.name);

    // AI change highlight for this column row
    const { className: colHL } = useFieldHighlight(highlightScopeId ?? '', `column:${table.id}:${col.id}`);

    const sourceConnections = useNodeConnections({ handleType: 'source', handleId: `${col.id}-source` });
    const targetConnections = useNodeConnections({ handleType: 'target', handleId: `${col.id}-target` });

    const isSourceConnected = sourceConnections.length > 0;
    const isTargetConnected = targetConnections.length > 0;

    const nameInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      if (isEditingName && nameInputRef.current) {
        nameInputRef.current.focus();
      }
    }, [isEditingName]);

    const handleNameSave = () => {
      setIsEditingName(false);
      if (editName.trim() && editName !== col.name) {
        onUpdateColumn(col.id, { name: editName.trim() });
      } else {
        setEditName(col.name);
      }
    };

    const handleTogglePrimaryKey = () => {
      onUpdateColumn(col.id, { is_primary_key: !col.is_primary_key });
    };

    const handleToggleAutoIncrement = () => {
      if (!col.is_primary_key) return;
      onUpdateColumn(col.id, { is_auto_increment: !col.is_auto_increment });
    };

    return (
      <div
        className={`flex items-center justify-between px-4 border-b border-border-strong last:border-b-0 relative group hover:bg-background-base transition-colors h-[32px] py-1 ${colHL}`}
      >
        {/* Target Handle (Left) */}
        <Handle
          type="target"
          position={Position.Left}
          id={`${col.id}-target`}
          className={`!border-none !bg-transparent z-20 !cursor-crosshair flex items-center justify-center
            ${isTargetConnected ? '!opacity-100' : '!opacity-0 group-hover:!opacity-100 hover:!opacity-100'}
          `}
          style={{ width: '10px', height: '10px', left: '-5px', top: '50%', transform: 'translateY(-50%)' }}
        >
          <div className="w-full h-full bg-success rounded-full transition-transform duration-150 group-hover:scale-[2] hover:scale-[2] hover:shadow-[0_0_8px_color-mix(in_srgb,var(--success)_60%,transparent)]" />
        </Handle>

        {/* PK Icon / Column Name */}
        <div className="flex items-center gap-1.5 z-0 flex-1 min-w-0">
          <Tooltip content={col.is_primary_key ? t('erDesigner.primaryKey') : t('erDesigner.clickToSetPK')}>
            <button
              type="button"
              className={`nodrag cursor-pointer shrink-0 p-1 -ml-1 rounded-sm hover:bg-background-hover transition-colors flex items-center justify-center outline-none ${col.is_primary_key ? 'text-key-primary' : 'text-foreground-subtle hover:text-foreground-default'}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleTogglePrimaryKey();
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <Key size={13} />
            </button>
          </Tooltip>
          {col.is_primary_key && (
            <Tooltip content={col.is_auto_increment ? t('erDesigner.autoIncrement') : t('erDesigner.clickToSetAI')}>
              <button
                type="button"
                className={`nodrag cursor-pointer shrink-0 p-1 rounded-sm hover:bg-background-hover transition-colors flex items-center justify-center outline-none ${col.is_auto_increment ? 'text-accent' : 'text-foreground-subtle hover:text-foreground-default'}`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleToggleAutoIncrement();
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <Hash size={13} />
              </button>
            </Tooltip>
          )}

          {isEditingName ? (
            <input
              ref={nameInputRef}
              className="nodrag bg-background-elevated text-foreground text-[13px] px-1.5 py-0 leading-[20px] rounded outline-none border border-accent flex-1 min-w-0"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleNameSave}
              onKeyDown={(e) => e.key === 'Enter' && handleNameSave()}
            />
          ) : (
            <span
              className="text-foreground text-[13px] cursor-text hover:bg-border-strong px-1.5 py-0 leading-[20px] rounded truncate flex-1 min-w-0 inline-block border border-transparent hover:border-foreground-subtle transition-colors"
              onDoubleClick={() => setIsEditingName(true)}
            >
              {col.name}
            </span>
          )}
        </div>

        {/* Right controls: Type + Delete */}
        <div className="flex items-center gap-1 shrink-0 ml-auto">
          {/* Type Dropdown */}
          <div className="z-0 w-[95px] flex justify-end">
            <DropdownSelect
              value={col.data_type}
              options={typeOptions}
              displayValue={formatTypeDisplay(col)}
              onChange={(value) => {
                const typeDef = findTypeDef(value, boundDialect as DialectName | null);
                onUpdateColumn(col.id, {
                  data_type: value,
                  length: typeDef?.defaultLength ?? null,
                  scale: typeDef?.defaultScale ?? null,
                });
              }}
              className="w-full text-right"
              plain
            />
          </div>

          {/* Delete Column Button */}
          <button
            type="button"
            className="nodrag cursor-pointer text-foreground-subtle hover:text-error shrink-0 z-10 p-1.5 -my-1.5 -mr-1.5 rounded-sm hover:bg-background-hover transition-colors flex items-center justify-center outline-none"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDeleteColumn(col.id);
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <X size={13} />
          </button>
        </div>

        {/* Source Handle (Right) */}
        <Handle
          type="source"
          position={Position.Right}
          id={`${col.id}-source`}
          className={`!border-none !bg-transparent z-20 !cursor-crosshair flex items-center justify-center
            ${isSourceConnected ? '!opacity-100' : '!opacity-0 group-hover:!opacity-100 hover:!opacity-100'}
          `}
          style={{ width: '10px', height: '10px', right: '-5px', top: '50%', transform: 'translateY(-50%)' }}
        >
          <div className="w-full h-full bg-error rounded-full transition-transform duration-150 group-hover:scale-[2] hover:scale-[2] hover:shadow-[0_0_8px_color-mix(in_srgb,var(--error)_60%,transparent)]" />
        </Handle>
      </div>
    );
  };

  return (
    <div
      className={`group/table bg-background-panel rounded-lg border shadow-xl overflow-visible w-[280px] font-sans transition-all ${tableHL}`}
      style={{
        borderColor: table.color || 'var(--border-strong)',
        boxShadow: table.color ? `0 4px 12px ${table.color}20` : undefined,
      }}
      onContextMenu={dispatchContextMenu}
    >
      {/* Header */}
      <div
        className={`px-3 py-1.5 border-b rounded-t-[7px] flex justify-between items-center transition-colors ${nameHL}`}
        style={{
          backgroundColor: table.color ? `${table.color}15` : 'var(--background-hover)',
          borderColor: table.color || 'var(--border-strong)',
        }}
      >
        {isEditingName ? (
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <TableProperties size={14} className="shrink-0" style={{ color: table.color || 'var(--accent)' }} />
            <input
              ref={nameInputRef}
              className="bg-border-strong text-foreground-default text-[13px] font-medium px-1.5 py-0.5 rounded outline-none border flex-1 min-w-0"
              style={{ borderColor: table.color || 'var(--accent)' }}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleNameSave}
              onKeyDown={(e) => e.key === 'Enter' && handleNameSave()}
            />
          </div>
        ) : (
          <Tooltip content={t('erDesigner.dblClickToEditName')} className="flex-1 min-w-0">
            <h3
              className="text-foreground-default text-[13px] font-medium truncate cursor-text hover:bg-border-strong px-1.5 py-0.5 -ml-1.5 rounded transition-colors flex items-center gap-1.5"
              onDoubleClick={() => setIsEditingName(true)}
            >
              <TableProperties size={14} className="shrink-0" style={{ color: table.color || 'var(--accent)' }} />
              <span className="truncate">{table.name}</span>
            </h3>
          </Tooltip>
        )}
        {majorityConstraintMethod && (
          <Tooltip
            content={majorityConstraintMethod === 'database_fk' ? '约束方式：数据库外键' : '约束方式：注释引用'}
            className="shrink-0 ml-1"
          >
            <span
              className="w-2 h-2 rounded-full inline-block"
              style={{
                backgroundColor: majorityConstraintMethod === 'database_fk'
                  ? 'var(--accent)'
                  : 'var(--warning)',
              }}
            />
          </Tooltip>
        )}
      </div>

      {/* Columns */}
      <div className="flex flex-col">
        {columns.map((col) => (
          <ColumnRow key={col.id} col={col} />
        ))}
      </div>

      {/* Add Column Button */}
      <button
        type="button"
        className="nodrag w-full px-3 py-2 border-t border-border-strong text-center cursor-pointer hover:bg-background-hover transition-colors outline-none block"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onAddColumn();
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className="text-[11px] font-medium text-accent">+ {t('erDesigner.addColumnBtn')}</span>
      </button>
    </div>
  );
}
