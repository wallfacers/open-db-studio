import React, { useLayoutEffect, useRef, useState } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

export type ClickTarget = 'row' | 'cell';

interface RowContextMenuProps {
  x: number;
  y: number;
  target: ClickTarget;
  rowData: (string | number | boolean | null)[];
  columns: string[];
  colIdx: number;
  pkColumn: string;
  tableName: string;
  dbDriver?: string;
  onClose: () => void;
  onSetNull: () => void;
  onCloneRow: () => void;
  onDeleteRow: () => void;
  onOpenEditor?: () => void;
  showToast: (msg: string, level?: 'success' | 'error' | 'info' | 'warning') => void;
}

// 根据数据库类型返回标识符引号函数和字符串转义函数
function getSqlDialect(driver?: string): {
  quoteIdent: (s: string) => string;
  escapeStr: (s: string) => string;
} {
  const d = (driver ?? '').toLowerCase();
  // SQL Server：方括号引用，单引号加倍转义
  if (d === 'sqlserver' || d === 'mssql') {
    return {
      quoteIdent: (s) => `[${s.replace(/]/g, ']]')}]`,
      escapeStr: (s) => `'${s.replace(/'/g, "''")}'`,
    };
  }
  // PostgreSQL、Oracle、GaussDB、DM、KingBase 等：双引号引用，单引号加倍转义
  if (['postgres', 'postgresql', 'oracle', 'gaussdb', 'greenplum', 'dm', 'kingbase'].includes(d)) {
    return {
      quoteIdent: (s) => `"${s.replace(/"/g, '""')}"`,
      escapeStr: (s) => `'${s.replace(/'/g, "''")}'`,
    };
  }
  // MySQL、TiDB、Doris、ClickHouse、SQLite 等（默认）：反引号引用，反斜杠转义
  return {
    quoteIdent: (s) => `\`${s.replace(/`/g, '``')}\``,
    escapeStr: (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`,
  };
}

export const RowContextMenu: React.FC<RowContextMenuProps> = ({
  x, y, target, rowData, columns, colIdx, pkColumn, tableName, dbDriver,
  onClose, onSetNull, onCloneRow, onDeleteRow, onOpenEditor, showToast,
}) => {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const sqlSubmenuItemRef = useRef<HTMLDivElement>(null);
  const [sqlSubmenuOpen, setSqlSubmenuOpen] = useState(false);
  const [sqlSubmenuToLeft, setSqlSubmenuToLeft] = useState(false);
  const [sqlSubmenuToTop, setSqlSubmenuToTop] = useState(false);
  const [pos, setPos] = useState({ x, y });

  // 渲染后检测溢出并调整位置
  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const { width, height } = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const nx = x + width > vw ? Math.max(4, vw - width - 4) : x;
    const ny = y + height > vh ? Math.max(4, vh - height - 4) : y;
    if (nx !== x || ny !== y) setPos({ x: nx, y: ny });
  }, [x, y]);

  useClickOutside(menuRef, onClose);

  const copyToClipboard = async (text: string) => {
    try {
      await writeText(text);
      showToast(t('tableDataView.sqlCopied'), 'success');
    } catch (e) {
      showToast(`${t('tableDataView.copyFailed')}: ${String(e)}`, 'error');
    }
    onClose();
  };

  const handleCopyCell = () => {
    const val = rowData[colIdx];
    copyToClipboard(val === null ? 'NULL' : String(val));
  };

  const handleCopyRow = () => {
    copyToClipboard(rowData.map(v => v === null ? 'NULL' : String(v)).join('\t'));
  };

  const { quoteIdent, escapeStr } = getSqlDialect(dbDriver);

  const buildInsertSql = () => {
    const cols = columns.map(c => quoteIdent(c)).join(', ');
    const vals = rowData.map(v => v === null ? 'NULL' : escapeStr(String(v))).join(', ');
    return `INSERT INTO ${quoteIdent(tableName)} (${cols}) VALUES (${vals});`;
  };

  const buildUpdateSql = () => {
    const pkIdx = columns.indexOf(pkColumn);
    const pkVal = pkIdx >= 0 ? rowData[pkIdx] : null;
    const sets = columns
      .map((c, i) => `${quoteIdent(c)} = ${rowData[i] === null ? 'NULL' : escapeStr(String(rowData[i]))}`)
      .join(', ');
    return `UPDATE ${quoteIdent(tableName)} SET ${sets} WHERE ${quoteIdent(pkColumn)} = ${escapeStr(String(pkVal ?? ''))};`;
  };

  const buildDeleteSql = () => {
    const pkIdx = columns.indexOf(pkColumn);
    const pkVal = pkIdx >= 0 ? rowData[pkIdx] : null;
    return `DELETE FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(pkColumn)} = ${escapeStr(String(pkVal ?? ''))};`;
  };

  const itemClass = 'px-4 py-1.5 hover:bg-background-hover cursor-pointer text-foreground-default flex items-center justify-between transition-colors duration-150';
  const dividerClass = 'border-t border-border-default my-1';

  return (
    <div
      ref={menuRef}
      style={{ position: 'fixed', top: pos.y, left: pos.x, zIndex: 9999 }}
      className="bg-background-base border border-border-default rounded shadow-xl text-xs min-w-[160px] py-1"
      onContextMenu={e => e.preventDefault()}
    >
      {target === 'cell' && (
        <div className={itemClass} onClick={handleCopyCell}>
          {t('tableDataView.copyCellValue')}
        </div>
      )}
      {target === 'cell' && onOpenEditor && (
        <div className={itemClass} onClick={() => { onOpenEditor(); onClose(); }}>
          {t('tableDataView.openInEditor')}
        </div>
      )}
      <div className={itemClass} onClick={handleCopyRow}>
        {t('tableDataView.copyRow')}
      </div>

      <div className={dividerClass} />

      {target === 'cell' && (
        <div className={itemClass} onClick={() => { onSetNull(); onClose(); }}>
          {t('tableDataView.setAsNull')}
        </div>
      )}
      <div className={itemClass} onClick={() => { onCloneRow(); onClose(); }}>
        {t('tableDataView.cloneRow')}
      </div>
      <div className={itemClass} onClick={() => { onDeleteRow(); onClose(); }}>
        <span className="text-error">{t('tableDataView.deleteRowMenuItem')}</span>
      </div>

      <div className={dividerClass} />

      <div
        ref={sqlSubmenuItemRef}
        className={`${itemClass} relative`}
        onClick={e => {
          e.stopPropagation();
          if (!sqlSubmenuOpen && sqlSubmenuItemRef.current) {
            const rect = sqlSubmenuItemRef.current.getBoundingClientRect();
            setSqlSubmenuToLeft(rect.right + 160 > window.innerWidth);
            // 3 items × ~28px + 8px padding ≈ 92px
            setSqlSubmenuToTop(rect.bottom + 92 > window.innerHeight);
          }
          setSqlSubmenuOpen(v => !v);
        }}
      >
        <span>{t('tableDataView.copyAsSql')}</span>
        <ChevronRight size={12} className="text-foreground-muted" />
        {sqlSubmenuOpen && (
          <div className={`absolute ${sqlSubmenuToLeft ? 'right-full' : 'left-full'} ${sqlSubmenuToTop ? 'bottom-0' : 'top-0'} bg-background-base border border-border-default rounded shadow-xl text-xs min-w-[140px] py-1`}>
            <div className={itemClass} onClick={() => copyToClipboard(buildInsertSql())}>
              {t('tableDataView.copyAsInsertSql')}
            </div>
            <div className={itemClass} onClick={() => copyToClipboard(buildUpdateSql())}>
              {t('tableDataView.copyAsUpdateSql')}
            </div>
            <div className={itemClass} onClick={() => copyToClipboard(buildDeleteSql())}>
              {t('tableDataView.copyAsDeleteSql')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
