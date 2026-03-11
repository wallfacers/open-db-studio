import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager';

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
  onPaste: (text: string) => void;
  showToast: (msg: string, level?: 'success' | 'error' | 'info' | 'warning') => void;
}

export const RowContextMenu: React.FC<RowContextMenuProps> = ({
  x, y, target, rowData, columns, colIdx, pkColumn, tableName,
  onClose, onSetNull, onCloneRow, onDeleteRow, onPaste, showToast,
}) => {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [sqlSubmenuOpen, setSqlSubmenuOpen] = useState(false);

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
    await writeText(text);
    showToast(t('tableDataView.sqlCopied'), 'success');
    onClose();
  };

  const handleCopyCell = () => {
    const val = rowData[colIdx];
    copyToClipboard(val === null ? 'NULL' : String(val));
  };

  const handleCopyRow = () => {
    copyToClipboard(rowData.map(v => v === null ? 'NULL' : String(v)).join('\t'));
  };

  const handlePaste = async () => {
    try {
      const text = await readText();
      if (text) onPaste(text);
    } catch {}
    onClose();
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
    return `UPDATE \`${tableName}\` SET ${sets} WHERE \`${pkColumn}\` = '${pkVal}';`;
  };

  const buildDeleteSql = () => {
    const pkIdx = columns.indexOf(pkColumn);
    const pkVal = pkIdx >= 0 ? rowData[pkIdx] : null;
    return `DELETE FROM \`${tableName}\` WHERE \`${pkColumn}\` = '${pkVal}';`;
  };

  const itemClass = 'px-4 py-1.5 hover:bg-[#1a2639] cursor-pointer text-[#c8daea] flex items-center justify-between';
  const dividerClass = 'border-t border-[#1e2d42] my-1';

  return (
    <div
      ref={menuRef}
      style={{ position: 'fixed', top: y, left: x, zIndex: 9999 }}
      className="bg-[#0d1117] border border-[#1e2d42] rounded shadow-xl text-xs min-w-[160px] py-1"
      onContextMenu={e => e.preventDefault()}
    >
      {target === 'cell' && (
        <div className={itemClass} onClick={handleCopyCell}>
          {t('tableDataView.copyCellValue')}
        </div>
      )}
      <div className={itemClass} onClick={handleCopyRow}>
        {t('tableDataView.copyRow')}
      </div>
      <div className={itemClass} onClick={handlePaste}>
        {t('tableDataView.paste')}
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
        className={`${itemClass} relative`}
        onMouseEnter={() => setSqlSubmenuOpen(true)}
        onMouseLeave={() => setSqlSubmenuOpen(false)}
      >
        <span>{t('tableDataView.copyAsSql')}</span>
        <ChevronRight size={12} className="text-[#7a9bb8]" />
        {sqlSubmenuOpen && (
          <div className="absolute left-full top-0 bg-[#0d1117] border border-[#1e2d42] rounded shadow-xl text-xs min-w-[140px] py-1">
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
