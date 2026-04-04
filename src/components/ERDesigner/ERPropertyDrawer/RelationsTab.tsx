import { useErDesignerStore } from '@/store/erDesignerStore';
import { CONSTRAINT_METHOD_LABELS, COMMENT_FORMAT_VALUES } from '../shared/constraintConstants';
import { resolveConstraintMethod, resolveCommentFormat } from '../shared/resolveConstraint';

interface Props { tableId: number }

export default function RelationsTab({ tableId }: Props) {
  const {
    tables, relations, columns, projects, activeProjectId,
    updateTable, updateRelation,
  } = useErDesignerStore();

  const table = tables.find(t => t.id === tableId);
  const project = projects.find(p => p.id === activeProjectId);

  const tableRelations = relations.filter(
    r => r.source_table_id === tableId || r.target_table_id === tableId
  );

  const projectMethod = resolveConstraintMethod(null, null, project);
  const projectFormat = resolveCommentFormat(null, null, project);
  const tableEffectiveMethod = resolveConstraintMethod(null, table, project);
  const tableEffectiveFormat = resolveCommentFormat(null, table, project);

  const handleTableConstraintMethod = (value: string) => {
    updateTable(tableId, { constraint_method: value === '' ? null : value });
  };

  const handleTableCommentFormat = (value: string) => {
    updateTable(tableId, { comment_format: value === '' ? null : value });
  };

  const handleRelationConstraintMethod = (relId: number, value: string) => {
    updateRelation(relId, { constraint_method: value === '' ? null : value });
  };

  const handleRelationCommentFormat = (relId: number, value: string) => {
    updateRelation(relId, { comment_format: value === '' ? null : value });
  };

  const getRelationLabel = (rel: typeof tableRelations[number]) => {
    const srcTable = tables.find(t => t.id === rel.source_table_id);
    const tgtTable = tables.find(t => t.id === rel.target_table_id);
    const srcCol = columns[rel.source_table_id]?.find(c => c.id === rel.source_column_id);
    const tgtCol = columns[rel.target_table_id]?.find(c => c.id === rel.target_column_id);
    return `${srcTable?.name ?? '?'}.${srcCol?.name ?? '?'} → ${tgtTable?.name ?? '?'}.${tgtCol?.name ?? '?'}`;
  };

  const getRelationEffectiveMethod = (rel: typeof tableRelations[number]) => {
    return resolveConstraintMethod(rel, table, project);
  };

  const getRelationEffectiveFormat = (rel: typeof tableRelations[number]) => {
    return resolveCommentFormat(rel, table, project);
  };

  return (
    <div className="p-3 space-y-4">
      {/* ── 表级默认设置 ── */}
      <div className="space-y-2">
        <div className="text-[11px] font-medium text-foreground-muted uppercase tracking-wide">
          表级默认（覆盖项目设置）
        </div>

        <div className="flex items-center gap-2">
          <label className="text-[12px] text-foreground-default w-20 shrink-0">约束方式</label>
          <select
            value={table?.constraint_method ?? ''}
            onChange={e => handleTableConstraintMethod(e.target.value)}
            className="flex-1 bg-background-base border border-border-strong rounded px-2 py-1 text-[12px] text-foreground-default"
          >
            <option value="">继承项目（{CONSTRAINT_METHOD_LABELS[projectMethod] ?? projectMethod}）</option>
            {Object.entries(CONSTRAINT_METHOD_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>

        {/* comment_format（仅 comment_ref 时显示）*/}
        {tableEffectiveMethod === 'comment_ref' && (
          <div className="flex items-center gap-2">
            <label className="text-[12px] text-foreground-default w-20 shrink-0">注释格式</label>
            <select
              value={table?.comment_format ?? ''}
              onChange={e => handleTableCommentFormat(e.target.value)}
              className="flex-1 bg-background-base border border-border-strong rounded px-2 py-1 text-[12px] text-foreground-default font-mono"
            >
              <option value="">继承项目（{projectFormat}）</option>
              {COMMENT_FORMAT_VALUES.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* ── 关系列表 ── */}
      {tableRelations.length > 0 && (
        <div className="space-y-2">
          <div className="text-[11px] font-medium text-foreground-muted uppercase tracking-wide">
            涉及的关系（{tableRelations.length}）
          </div>
          <div className="space-y-1">
            {tableRelations.map(rel => {
              const effMethod = getRelationEffectiveMethod(rel);
              const effFormat = getRelationEffectiveFormat(rel);
              const isOverriding = rel.constraint_method !== null || rel.comment_format !== null;
              return (
                <div key={rel.id} className="border border-border-strong rounded p-2 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-foreground-default font-mono truncate">
                      {getRelationLabel(rel)}
                    </span>
                    <span className="text-[10px] shrink-0 ml-1 px-1 rounded"
                      style={{ color: isOverriding ? 'var(--warning)' : 'var(--foreground-muted)' }}>
                      {isOverriding ? '已覆盖' : '继承'}
                    </span>
                  </div>
                  {/* 关系级约束方式 */}
                  <div className="flex items-center gap-2">
                    <select
                      value={rel.constraint_method ?? ''}
                      onChange={e => handleRelationConstraintMethod(rel.id, e.target.value)}
                      className="flex-1 bg-background-base border border-border-strong rounded px-2 py-0.5 text-[11px] text-foreground-default"
                    >
                      <option value="">继承（{CONSTRAINT_METHOD_LABELS[tableEffectiveMethod] ?? tableEffectiveMethod}）</option>
                      {Object.entries(CONSTRAINT_METHOD_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </div>
                  {/* 注释格式（仅 comment_ref 时显示）*/}
                  {effMethod === 'comment_ref' && (
                    <div className="flex items-center gap-2">
                      <select
                        value={rel.comment_format ?? ''}
                        onChange={e => handleRelationCommentFormat(rel.id, e.target.value)}
                        className="flex-1 bg-background-base border border-border-strong rounded px-2 py-0.5 text-[11px] text-foreground-default font-mono"
                      >
                        <option value="">继承（{effFormat}）</option>
                        {COMMENT_FORMAT_VALUES.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tableRelations.length === 0 && (
        <div className="text-[12px] text-foreground-muted text-center py-4">
          该表暂无关系
        </div>
      )}
    </div>
  );
}
