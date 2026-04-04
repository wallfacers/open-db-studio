import React from 'react';
import { BaseModal } from '../../common/BaseModal';
import { useErDesignerStore } from '@/store/erDesignerStore';

interface Props {
  visible: boolean;
  projectId: number;
  onClose: () => void;
}

const COMMENT_FORMAT_OPTIONS = [
  { value: '@ref', label: '@ref:table.col' },
  { value: '@fk', label: '@fk(table,col,type)' },
  { value: '[ref]', label: '[ref:table.col]' },
  { value: '$$ref$$', label: '$$ref(table.col)$$' },
];

export const ProjectSettingsDialog: React.FC<Props> = ({ visible, projectId, onClose }) => {
  const { projects, updateProject } = useErDesignerStore();
  const project = projects.find(p => p.id === projectId);

  if (!visible || !project) return null;

  const handleConstraintMethod = (value: string) => {
    updateProject(projectId, { default_constraint_method: value });
  };

  const handleCommentFormat = (value: string) => {
    updateProject(projectId, { default_comment_format: value });
  };

  return (
    <BaseModal title="项目设置" onClose={onClose} width={400}>
      <div className="space-y-4">
        {/* 约束方式默认值 */}
        <div>
          <div className="text-[12px] font-medium text-foreground-default mb-2">
            约束方式默认值
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="constraint_method"
                value="database_fk"
                checked={project.default_constraint_method === 'database_fk'}
                onChange={() => handleConstraintMethod('database_fk')}
                className="accent-accent"
              />
              <span className="text-[12px] text-foreground-default">数据库外键 🔒</span>
              <span className="text-[11px] text-foreground-muted">（DDL 生成 FOREIGN KEY 约束）</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="constraint_method"
                value="comment_ref"
                checked={project.default_constraint_method === 'comment_ref'}
                onChange={() => handleConstraintMethod('comment_ref')}
                className="accent-accent"
              />
              <span className="text-[12px] text-foreground-default">注释引用 💬</span>
              <span className="text-[11px] text-foreground-muted">（在列注释中写入引用标记）</span>
            </label>
          </div>
        </div>

        {/* 注释格式（仅 comment_ref 时显示）*/}
        {project.default_constraint_method === 'comment_ref' && (
          <div>
            <div className="text-[12px] font-medium text-foreground-default mb-2">
              注释格式
            </div>
            <select
              value={project.default_comment_format}
              onChange={e => handleCommentFormat(e.target.value)}
              className="w-full bg-background-base border border-border-strong rounded px-2 py-1.5 text-[12px] text-foreground-default font-mono"
            >
              {COMMENT_FORMAT_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        )}

        <div className="text-[11px] text-foreground-muted pt-1 border-t border-border-strong">
          表级和关系级可单独覆盖这里的默认值。
        </div>
      </div>
    </BaseModal>
  );
};
