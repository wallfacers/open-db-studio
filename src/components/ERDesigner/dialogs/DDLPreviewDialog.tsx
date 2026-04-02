import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
          setDdl('-- ' + t('erDesigner.generateDdlFailed') + '\n' + String(err));
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
      title={t('erDesigner.generateDdl')}
      onClose={onClose}
      width={640}
      footerButtons={[
        {
          label: copied ? t('erDesigner.copied') : t('erDesigner.copyDdl'),
          onClick: handleCopy,
          variant: 'secondary',
        },
        {
          label: t('erDesigner.executeToDB'),
          onClick: handleExecute,
          variant: 'primary',
          disabled: !hasConnection || loading || !ddl || ddl.startsWith('--'),
        },
      ]}
    >
      <div className="flex flex-col gap-4">
        {/* 方言选择 */}
        <div className="flex items-center gap-4">
          <span className="text-xs text-foreground-default">{t('erDesigner.dialect')}:</span>
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
              className="accent-accent w-4 h-4"
            />
            <span className="text-xs text-foreground-default">{t('erDesigner.includeIndexes')}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeComments}
              onChange={(e) => setIncludeComments(e.target.checked)}
              className="accent-accent w-4 h-4"
            />
            <span className="text-xs text-foreground-default">{t('erDesigner.includeComments')}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeForeignKeys}
              onChange={(e) => setIncludeForeignKeys(e.target.checked)}
              className="accent-accent w-4 h-4"
            />
            <span className="text-xs text-foreground-default">{t('erDesigner.includeForeignKeys')}</span>
          </label>
        </div>

        {/* DDL 代码区域 */}
        <div className="relative">
          <pre
            className={`bg-background-base text-info-foreground font-mono text-xs p-4 rounded
                       border border-border-default overflow-auto max-h-80
                       ${loading ? 'opacity-50' : ''}`}
          >
            {loading ? t('erDesigner.generating') : ddl || t('erDesigner.noDdl')}
          </pre>
        </div>

        {/* 执行提示 */}
        {!hasConnection && (
          <div className="text-xs text-foreground-muted">
            {t('erDesigner.executeNeedsConnection')}
          </div>
        )}
      </div>
    </BaseModal>
  );
};
