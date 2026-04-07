import { useErDesignerStore } from '@/store/erDesignerStore';
import { DropdownSelect } from '@/components/common/DropdownSelect';
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
          <DropdownSelect
            value={table?.constraint_method ?? ''}
            onChange={handleTableConstraintMethod}
            placeholder={`继承项目（${CONSTRAINT_METHOD_LABELS[projectMethod] ?? projectMethod}）`}
            options={Object.entries(CONSTRAINT_METHOD_LABELS).map(([k, v]) => ({ value: k, label: v }))}
            className="flex-1"
          />
        </div>

        {/* comment_format（仅 comment_ref 时显示）*/}
        {tableEffectiveMethod === 'comment_ref' && (
          <div className="flex items-center gap-2">
            <label className="text-[12px] text-foreground-default w-20 shrink-0">注释格式</label>
            <DropdownSelect
              value={table?.comment_format ?? ''}
              onChange={handleTableCommentFormat}
              placeholder={`继承项目（${projectFormat}）`}
              options={COMMENT_FORMAT_VALUES.map(o => ({ value: o.value, label: o.label }))}
              className="flex-1"
            />
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
                    <DropdownSelect
                      value={rel.constraint_method ?? ''}
                      onChange={v => handleRelationConstraintMethod(rel.id, v)}
                      placeholder={`继承（${CONSTRAINT_METHOD_LABELS[tableEffectiveMethod] ?? tableEffectiveMethod}）`}
                      options={Object.entries(CONSTRAINT_METHOD_LABELS).map(([k, v]) => ({ value: k, label: v }))}
                      className="flex-1"
                    />
                  </div>
                  {/* 注释格式（仅 comment_ref 时显示）*/}
                  {effMethod === 'comment_ref' && (
                    <div className="flex items-center gap-2">
                      <DropdownSelect
                        value={rel.comment_format ?? ''}
                        onChange={v => handleRelationCommentFormat(rel.id, v)}
                        placeholder={`继承（${effFormat}）`}
                        options={COMMENT_FORMAT_VALUES.map(o => ({ value: o.value, label: o.label }))}
                        className="flex-1"
                      />
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
