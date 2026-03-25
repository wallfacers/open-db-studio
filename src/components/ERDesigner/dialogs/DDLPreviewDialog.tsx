import React, { useState, useEffect } from 'react';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import { BaseModal } from '../../common/BaseModal';
import { DropdownSelect } from '../../common/DropdownSelect';

export interface DDLPreviewDialogProps {
  visible: boolean;
  projectId: number;
  hasConnection: boolean;
  onClose: () => void;
  onExecute: (ddl: string) => void;
}

type SqlDialect = 'mysql' | 'postgresql' | 'oracle' | 'sqlserver' | 'sqlite';

const DIALECT_OPTIONS: { value: SqlDialect; label: string }[] = [
  { value: 'mysql', label: 'MySQL' },
  { value: 'postgresql', label: 'PostgreSQL' },
  { value: 'oracle', label: 'Oracle' },
  { value: 'sqlserver', label: 'SQL Server' },
  { value: 'sqlite', label: 'SQLite' },
];

export const DDLPreviewDialog: React.FC<DDLPreviewDialogProps> = ({
  visible,
  projectId,
  hasConnection,
  onClose,
  onExecute,
}) => {
  const generateDDL = useErDesignerStore((s) => s.generateDDL);

  const [dialect, setDialect] = useState<SqlDialect>('mysql');
  const [includeIndexes, setIncludeIndexes] = useState(true);
  const [includeComments, setIncludeComments] = useState(true);
  const [includeForeignKeys, setIncludeForeignKeys] = useState(false);
  const [ddl, setDdl] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // 切换方言或选项时重新生成 DDL
  useEffect(() => {
    if (visible && projectId) {
      setLoading(true);
      generateDDL(projectId, dialect, {
        includeIndexes,
        includeComments,
        includeForeignKeys,
      })
        .then((result) => {
          setDdl(result);
        })
        .catch((err) => {
          console.error('Failed to generate DDL:', err);
          setDdl('-- 生成 DDL 失败\n' + String(err));
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [visible, projectId, dialect, includeIndexes, includeComments, includeForeignKeys, generateDDL]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(ddl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleExecute = () => {
    onExecute(ddl);
    onClose();
  };

  if (!visible) return null;

  return (
    <BaseModal
      title="生成 DDL"
      onClose={onClose}
      width={640}
      footerButtons={[
        {
          label: '复制',
          onClick: handleCopy,
          variant: 'secondary',
        },
        {
          label: '执行到数据库',
          onClick: handleExecute,
          variant: 'primary',
          disabled: !hasConnection || loading || !ddl || ddl.startsWith('--'),
        },
      ]}
    >
      <div className="flex flex-col gap-4">
        {/* 方言选择 */}
        <div className="flex items-center gap-4">
          <span className="text-xs text-[#c8daea]">方言:</span>
          <DropdownSelect
            value={dialect}
            options={DIALECT_OPTIONS}
            onChange={(val) => setDialect(val as SqlDialect)}
            className="w-32"
          />
        </div>

        {/* 选项开关 */}
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeIndexes}
              onChange={(e) => setIncludeIndexes(e.target.checked)}
              className="accent-[#00c9a7] w-4 h-4"
            />
            <span className="text-xs text-[#c8daea]">索引</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeComments}
              onChange={(e) => setIncludeComments(e.target.checked)}
              className="accent-[#00c9a7] w-4 h-4"
            />
            <span className="text-xs text-[#c8daea]">列注释(含标记)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeForeignKeys}
              onChange={(e) => setIncludeForeignKeys(e.target.checked)}
              className="accent-[#00c9a7] w-4 h-4"
            />
            <span className="text-xs text-[#c8daea]">外键约束</span>
          </label>
        </div>

        {/* DDL 代码区域 */}
        <div className="relative">
          <pre
            className={`bg-[#0d1117] text-[#a5d6ff] font-mono text-xs p-4 rounded
                       border border-[#1e2d42] overflow-auto max-h-80
                       ${loading ? 'opacity-50' : ''}`}
          >
            {loading ? '生成中...' : ddl || '暂无 DDL'}
          </pre>
        </div>

        {/* 执行提示 */}
        {!hasConnection && (
          <div className="text-xs text-[#7a9bb8]">
            提示：执行到数据库需要先绑定连接
          </div>
        )}
      </div>
    </BaseModal>
  );
};
