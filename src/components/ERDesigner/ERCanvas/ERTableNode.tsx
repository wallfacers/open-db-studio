import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Handle, Position, useNodeConnections } from '@xyflow/react';
import { Key, Hash, X, MoreVertical } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { DropdownSelect } from '../../common/DropdownSelect';

const SQL_TYPES = [
  { value: 'INT', label: 'INT' },
  { value: 'BIGINT', label: 'BIGINT' },
  { value: 'VARCHAR', label: 'VARCHAR' },
  { value: 'TEXT', label: 'TEXT' },
  { value: 'CHAR', label: 'CHAR' },
  { value: 'DATETIME', label: 'DATETIME' },
  { value: 'DATE', label: 'DATE' },
  { value: 'TIMESTAMP', label: 'TIMESTAMP' },
  { value: 'BOOLEAN', label: 'BOOLEAN' },
  { value: 'DECIMAL', label: 'DECIMAL' },
  { value: 'FLOAT', label: 'FLOAT' },
  { value: 'DOUBLE', label: 'DOUBLE' },
];

interface ERTableNodeData {
  table: import('../../../types').ErTable;
  columns: import('../../../types').ErColumn[];
  onUpdateTable: (updates: Partial<import('../../../types').ErTable>) => void;
  onAddColumn: () => void;
  onUpdateColumn: (colId: number, updates: Partial<import('../../../types').ErColumn>) => void;
  onDeleteColumn: (colId: number) => void;
  onDeleteTable: () => void;
}

export default function ERTableNode({ id, data }: { id: string; data: ERTableNodeData }) {
  const { t } = useTranslation();
  const { table, columns, onUpdateTable, onAddColumn, onUpdateColumn, onDeleteColumn, onDeleteTable } = data;

  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(table.name);
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  const nameInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, [isEditingName]);

  useLayoutEffect(() => {
    if (showMenu && menuTriggerRef.current) {
      const rect = menuTriggerRef.current.getBoundingClientRect();
      const dropdownHeight = 80;
      const openUpward = rect.bottom + dropdownHeight > window.innerHeight;
      setMenuPos({
        top: openUpward ? rect.top + window.scrollY : rect.bottom + window.scrollY,
        left: rect.left + window.scrollX,
      });
    }
  }, [showMenu]);

  useEffect(() => {
    if (showMenu) {
      const handleClickOutside = (e: MouseEvent) => {
        const target = e.target as Node;
        if (!menuRef.current?.contains(target) && !menuTriggerRef.current?.contains(target)) {
          setShowMenu(false);
        }
      };
      const timer = setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 10);
      return () => {
        clearTimeout(timer);
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [showMenu]);

  const handleNameSave = () => {
    setIsEditingName(false);
    if (editName.trim() && editName !== table.name) {
      onUpdateTable({ name: editName.trim() });
    } else {
      setEditName(table.name);
    }
  };

  const handleDeleteTable = () => {
    onDeleteTable();
  };

  const ColumnRow = ({ col }: { col: typeof columns[number] }) => {
    const { t } = useTranslation();
    const [isEditingName, setIsEditingName] = useState(false);
    const [editName, setEditName] = useState(col.name);

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
        className="flex items-center justify-between px-3 py-1.5 border-b border-[#253347] last:border-b-0 relative group hover:bg-[#0d1117] transition-colors h-[28px]"
      >
        {/* Target Handle (Left) - For incoming connections */}
        <Handle
          type="target"
          position={Position.Left}
          id={`${col.id}-target`}
          className={`!border-none !bg-transparent z-20 !cursor-crosshair flex items-center justify-center
            ${isTargetConnected ? '!opacity-100' : '!opacity-0 group-hover:!opacity-100 hover:!opacity-100'}
          `}
          style={{ width: '10px', height: '10px', left: '-5px', top: '50%', transform: 'translateY(-50%)' }}
        >
          <div className="w-full h-full bg-[#4ade80] rounded-full transition-transform duration-150 hover:scale-[2] hover:shadow-[0_0_8px_rgba(74,222,128,0.6)]" />
        </Handle>

        {/* PK Icon / Column Name */}
        <div className="flex items-center gap-2 z-0 flex-1 min-w-0">
          <div
            className={`cursor-pointer shrink-0 ${col.is_primary_key ? 'text-[#00c9a7]' : 'text-gray-500 hover:text-gray-300'}`}
            onClick={handleTogglePrimaryKey}
            title={col.is_primary_key ? t('erDesigner.primaryKey') : t('erDesigner.clickToSetPK')}
          >
            <Key className="w-3 h-3" />
          </div>
          {col.is_primary_key && (
            <span title={col.is_auto_increment ? t('erDesigner.autoIncrement') : t('erDesigner.clickToSetAI')}>
              <Hash
                className={`w-3 h-3 cursor-pointer shrink-0 ${col.is_auto_increment ? 'text-[#00c9a7]' : 'text-gray-500 hover:text-gray-300'}`}
                onClick={handleToggleAutoIncrement}
              />
            </span>
          )}

          {isEditingName ? (
            <input
              ref={nameInputRef}
              className="bg-[#151d28] text-gray-200 text-xs px-1 py-0.5 rounded outline-none border border-[#00c9a7]"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleNameSave}
              onKeyDown={(e) => e.key === 'Enter' && handleNameSave()}
              style={{ width: `${Math.max(editName.length * 7, 40)}px` }}
            />
          ) : (
            <span
              className="text-gray-300 text-xs cursor-text hover:bg-[#253347] px-1 py-0.5 -mx-1 rounded truncate"
              title={t('erDesigner.dblClickToEdit')}
              onDoubleClick={() => setIsEditingName(true)}
            >
              {col.name}
            </span>
          )}
        </div>

        {/* Type Dropdown */}
        <div className="z-0 shrink-0">
          <DropdownSelect
            value={col.data_type}
            options={SQL_TYPES}
            onChange={(value) => onUpdateColumn(col.id, { data_type: value })}
            plain
          />
        </div>

        {/* Delete Column Button */}
        <X
          size={10}
          className="opacity-0 group-hover:opacity-100 cursor-pointer text-gray-500 hover:text-red-400 shrink-0 ml-1 z-10"
          onClick={(e) => { e.stopPropagation(); onDeleteColumn(col.id); }}
        />

        {/* Source Handle (Right) - For outgoing connections */}
        <Handle
          type="source"
          position={Position.Right}
          id={`${col.id}-source`}
          className={`!border-none !bg-transparent z-20 !cursor-crosshair flex items-center justify-center
            ${isSourceConnected ? '!opacity-100' : '!opacity-0 group-hover:!opacity-100 hover:!opacity-100'}
          `}
          style={{ width: '10px', height: '10px', right: '-5px', top: '50%', transform: 'translateY(-50%)' }}
        >
          <div className="w-full h-full bg-[#f43f5e] rounded-full transition-transform duration-150 hover:scale-[2] hover:shadow-[0_0_8px_rgba(244,63,94,0.6)]" />
        </Handle>
      </div>
    );
  };

  return (
    <div className="bg-[#111922] rounded-lg border border-[#253347] shadow-xl overflow-visible min-w-[260px] font-sans">
      {/* Header */}
      <div className="bg-[#1a2639] px-4 py-2.5 border-b border-[#253347] rounded-t-lg flex justify-between items-center">
        {isEditingName ? (
          <input
            ref={nameInputRef}
            className="bg-[#253347] text-gray-200 text-sm font-medium px-2 py-0.5 rounded outline-none border border-[#00c9a7] flex-1"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleNameSave}
            onKeyDown={(e) => e.key === 'Enter' && handleNameSave()}
          />
        ) : (
          <h3
            className="text-gray-200 text-sm font-medium truncate cursor-text hover:bg-[#253347] px-2 py-0.5 -ml-2 rounded transition-colors flex-1"
            title={t('erDesigner.dblClickToEditName')}
            onDoubleClick={() => setIsEditingName(true)}
          >
            {table.name}
          </h3>
        )}

        {/* Menu Trigger */}
        <div ref={menuTriggerRef} className="relative shrink-0 ml-1">
          <MoreVertical
            size={14}
            className="text-gray-500 hover:text-gray-300 cursor-pointer"
            onClick={() => setShowMenu(!showMenu)}
          />
          {showMenu && createPortal(
            <div
              ref={menuRef}
              className="fixed bg-[#151d28] border border-[#2a3f5a] rounded shadow-lg z-[200] py-1 min-w-[120px]"
              style={{
                top: menuPos.top + 4,
                left: menuPos.left - 100,
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
            >
              <div
                className="px-3 py-1.5 text-xs cursor-pointer text-[#c8daea] hover:bg-[#1e2d42] hover:text-[#00c9a7]"
                onClick={() => { handleDeleteTable(); setShowMenu(false); }}
              >
                {t('erDesigner.deleteTable')}
              </div>
            </div>,
            document.body
          )}
        </div>
      </div>

      {/* Columns */}
      <div className="flex flex-col max-h-[400px] overflow-y-auto">
        {columns.map((col) => (
          <ColumnRow key={col.id} col={col} />
        ))}
      </div>

      {/* Add Column Button */}
      <div
        className="px-4 py-2 border-t border-[#253347] text-center cursor-pointer hover:bg-[#1a2639] transition-colors"
        onClick={onAddColumn}
      >
        <span className="text-xs text-[#00c9a7]">+ {t('erDesigner.addColumnBtn')}</span>
      </div>
    </div>
  );
}
