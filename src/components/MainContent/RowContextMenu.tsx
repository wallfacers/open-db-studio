import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  onClose: () => void;
  onSetNull: () => void;
  onCloneRow: () => void;
  onDeleteRow: () => void;
  onOpenEditor?: () => void;
  showToast: (msg: string, level?: 'success' | 'error' | 'info' | 'warning') => void;
}

export const RowContextMenu: React.FC<RowContextMenuProps> = ({
  x, y, target, rowData, columns, colIdx, pkColumn, tableName,
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

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

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

  const buildInsertSql = () => {
    const cols = columns.map(c => `\`${c}\``).join(', ');
    const vals = rowData.map(v => v === null ? 'NULL' : `'${String(v).replace(/'/g, "\\'")}'`).join(', ');
    return `INSERT INTO \`${tableName}\` (${cols}) VALUES (${vals});`;
  };

  const buildUpdateSql = () => {
    const pkIdx = columns.indexOf(pkColumn);
    const pkVal = pkIdx >= 0 ? rowData[pkIdx] : null;
    const sets = columns
      .map((c, i) => `\`${c}\` = ${rowData[i] === null ? 'NULL' : `'${String(rowData[i]).replace(/'/g, "\\'")}'`}`)
      .join(', ');
    return `UPDATE \`${tableName}\` SET ${sets} WHERE \`${pkColumn}\` = '${String(pkVal ?? '').replace(/'/g, "\\'")}';`;
  };

  const buildDeleteSql = () => {
    const pkIdx = columns.indexOf(pkColumn);
    const pkVal = pkIdx >= 0 ? rowData[pkIdx] : null;
    return `DELETE FROM \`${tableName}\` WHERE \`${pkColumn}\` = '${String(pkVal ?? '').replace(/'/g, "\\'")}';`;
  };

  const itemClass = 'px-4 py-1.5 hover:bg-[#1a2639] cursor-pointer text-[#c8daea] flex items-center justify-between';
  const dividerClass = 'border-t border-[#1e2d42] my-1';

  return (
    <div
      ref={menuRef}
      style={{ position: 'fixed', top: pos.y, left: pos.x, zIndex: 9999 }}
      className="bg-[#0d1117] border border-[#1e2d42] rounded shadow-xl text-xs min-w-[160px] py-1"
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
        <span className="text-red-400">{t('tableDataView.deleteRowMenuItem')}</span>
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
        <ChevronRight size={12} className="text-[#7a9bb8]" />
        {sqlSubmenuOpen && (
          <div className={`absolute ${sqlSubmenuToLeft ? 'right-full' : 'left-full'} ${sqlSubmenuToTop ? 'bottom-0' : 'top-0'} bg-[#0d1117] border border-[#1e2d42] rounded shadow-xl text-xs min-w-[140px] py-1`}>
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
