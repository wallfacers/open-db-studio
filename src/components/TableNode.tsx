import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Handle, Position, useNodeConnections, useReactFlow } from '@xyflow/react';
import { Key, Diamond } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

export type ColumnData = {
  name: string;
  type: string;
  isPrimary?: boolean;
  isForeign?: boolean;
};

export type TableNodeData = {
  tableName: string;
  columns: ColumnData[];
};

const commonSqlTypes = [
  'INT', 'VARCHAR', 'TEXT', 'DATETIME', 'DATE', 'BOOLEAN', 
  'DECIMAL', 'FLOAT', 'DOUBLE', 'BIGINT', 'CHAR', 'TIMESTAMP'
];

function TableRow({ col, nodeId, onUpdateColumn }: { col: ColumnData; nodeId: string; onUpdateColumn: (oldName: string, newCol: ColumnData) => void; key?: string }) {
  const { t } = useTranslation();
  const sourceConnections = useNodeConnections({ handleType: 'source', handleId: `${col.name}-source` });
  const targetConnections = useNodeConnections({ handleType: 'target', handleId: `${col.name}-target` });

  const isSourceConnected = sourceConnections.length > 0;
  const isTargetConnected = targetConnections.length > 0;

  const [isEditingName, setIsEditingName] = useState(false);
  const [isEditingType, setIsEditingType] = useState(false);
  const [isEditingKey, setIsEditingKey] = useState(false);
  
  const [editName, setEditName] = useState(col.name);
  const [editType, setEditType] = useState(col.type);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const typeSpanRef = useRef<HTMLSpanElement>(null);
  const keySpanRef = useRef<HTMLDivElement>(null);
  
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });
  const [keyDropdownPos, setKeyDropdownPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, [isEditingName]);

  useLayoutEffect(() => {
    if (isEditingType && typeSpanRef.current) {
      const rect = typeSpanRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.bottom + window.scrollY,
        left: rect.left + window.scrollX
      });
    }
  }, [isEditingType]);

  useLayoutEffect(() => {
    if (isEditingKey && keySpanRef.current) {
      const rect = keySpanRef.current.getBoundingClientRect();
      setKeyDropdownPos({
        top: rect.bottom + window.scrollY,
        left: rect.left + window.scrollX
      });
    }
  }, [isEditingKey]);

  useEffect(() => {
    if (isEditingType) {
      const handleClickOutside = () => setIsEditingType(false);
      const timer = setTimeout(() => document.addEventListener('pointerdown', handleClickOutside), 10);
      return () => {
        clearTimeout(timer);
        document.removeEventListener('pointerdown', handleClickOutside);
      };
    }
  }, [isEditingType]);

  useEffect(() => {
    if (isEditingKey) {
      const handleClickOutside = () => setIsEditingKey(false);
      const timer = setTimeout(() => document.addEventListener('pointerdown', handleClickOutside), 10);
      return () => {
        clearTimeout(timer);
        document.removeEventListener('pointerdown', handleClickOutside);
      };
    }
  }, [isEditingKey]);

  const handleNameSave = () => {
    setIsEditingName(false);
    if (editName.trim() && editName !== col.name) {
      onUpdateColumn(col.name, { ...col, name: editName.trim() });
    } else {
      setEditName(col.name);
    }
  };

  return (
    <div
      className={`flex items-center justify-between px-4 py-2 border-b border-[#333] last:border-b-0 relative group hover:bg-[#222] transition-colors h-[32px]`}
    >
      {/* Target Handle (Left) - For incoming connections */}
      <Handle
        type="target"
        position={Position.Left}
        id={`${col.name}-target`}
        className={`!border-none !bg-transparent z-20 !cursor-crosshair flex items-center justify-center
          ${col.isForeign || isTargetConnected ? '!opacity-100' : '!opacity-0 group-hover:!opacity-100 hover:!opacity-100'}
        `}
        style={{ width: '12px', height: '12px', left: '-6px', top: '50%', transform: 'translateY(-50%)' }}
      >
        <div className="w-full h-full bg-[#4ade80] rounded-full transition-transform duration-150 hover:scale-[2.5] hover:shadow-[0_0_12px_rgba(74,222,128,0.6)]" />
      </Handle>

      <div className="flex items-center gap-3 z-0 w-[120px]">
        {/* PK/FK Toggle Dropdown Area */}
        <div className="relative flex items-center">
          {isEditingKey && createPortal(
            <div
              className="fixed bg-[#252526] border border-[#3c3c3c] rounded shadow-2xl z-[999999] py-1 min-w-[120px] cursor-default"
              style={{ top: keyDropdownPos.top + 4, left: keyDropdownPos.left }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
            >
              <div
                className={`flex items-center px-3 py-1.5 cursor-pointer text-xs transition-colors ${
                  col.isPrimary ? 'bg-[#094771] text-white' : 'hover:bg-[#37373d] text-[#d4d4d4]'
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  onUpdateColumn(col.name, { ...col, isPrimary: !col.isPrimary });
                }}
              >
                <Key className="w-3 h-3 mr-1.5 text-[#eab308]" />
                {t('tableNode.primaryKey')}
              </div>
              <div
                className={`flex items-center px-3 py-1.5 cursor-pointer text-xs transition-colors ${
                  col.isForeign ? 'bg-[#094771] text-white' : 'hover:bg-[#37373d] text-[#d4d4d4]'
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  onUpdateColumn(col.name, { ...col, isForeign: !col.isForeign });
                }}
              >
                <Key className="w-3 h-3 mr-1.5 text-[#94a3b8]" />
                {t('tableNode.foreignKey')}
              </div>
            </div>,
            document.body
          )}

          <div
            ref={keySpanRef}
            className="flex items-center gap-[2px] cursor-pointer p-1 -ml-1 rounded hover:bg-[#333] min-w-[20px] h-[24px] transition-colors"
            title={t('tableNode.setKey')}
            onClick={(e) => {
              e.stopPropagation();
              setIsEditingKey(!isEditingKey);
            }}
          >
            {col.isPrimary && <Key className="w-3.5 h-3.5 text-[#eab308] shrink-0" />}
            {col.isForeign && <Key className="w-3.5 h-3.5 text-[#94a3b8] shrink-0" />}
            {!col.isPrimary && !col.isForeign && (
              <Key className="w-3.5 h-3.5 text-gray-500 opacity-0 group-hover:opacity-60 transition-opacity shrink-0" />
            )}
          </div>
        </div>

        {/* Column Name */}
        {isEditingName ? (
          <input
            ref={nameInputRef}
            className="bg-[#333] text-gray-200 text-xs font-medium px-1 py-0.5 rounded outline-none border border-[#3794ff]"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleNameSave}
            onKeyDown={(e) => e.key === 'Enter' && handleNameSave()}
            style={{ width: `${Math.max(editName.length * 7, 50)}px` }}
          />
        ) : (
          <span
            className="text-gray-300 text-xs font-medium cursor-text hover:bg-[#333] px-1 py-0.5 -mx-1 rounded truncate max-w-[90px]"
            title={`${t('tableNode.columnName')}${col.name}${t('tableNode.doubleClickToEdit')}`}
            onDoubleClick={() => setIsEditingName(true)}
          >
            {col.name}
          </span>
        )}
      </div>

      {/* Column Type */}
      <div className="z-0 flex-1 flex justify-end items-center relative">
        {isEditingType && createPortal(
          <div
            className="fixed bg-[#252526] border border-[#3c3c3c] rounded shadow-2xl z-[999999] py-1 min-w-[120px] cursor-default"
            style={{ top: dropdownPos.top + 4, left: dropdownPos.left - 40 }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            {commonSqlTypes.map(type => (
              <div
                key={type}
                className={`px-3 py-1.5 cursor-pointer text-xs font-mono transition-colors ${
                  type === col.type ? 'bg-[#094771] text-white' : 'hover:bg-[#37373d] text-[#d4d4d4]'
                }`}
                onClick={() => {
                  setEditType(type);
                  onUpdateColumn(col.name, { ...col, type });
                  setIsEditingType(false);
                }}
              >
                {type}
              </div>
            ))}
          </div>,
          document.body
        )}

        {/* We keep the span always visible, but click triggers the menu */}
        <span
          ref={typeSpanRef}
          className={`text-gray-500 text-xs font-mono cursor-pointer hover:bg-[#333] px-1 py-0.5 -mx-1 rounded ${isEditingType ? 'bg-[#333] border border-[#3794ff]' : ''}`}
          title={`${t('tableNode.type')}${col.type}${t('tableNode.doubleClickToEdit')}`}
          onDoubleClick={() => setIsEditingType(true)}
          onClick={(e) => {
            e.stopPropagation();
            if(isEditingType) setIsEditingType(false);
          }}
        >
          {col.type}
        </span>
      </div>

      {/* Source Handle (Right) - For outgoing connections */}
      <Handle
        type="source"
        position={Position.Right}
        id={`${col.name}-source`}
        className={`!border-none !bg-transparent z-20 !cursor-crosshair flex items-center justify-center
          ${col.isPrimary || isSourceConnected ? '!opacity-100' : '!opacity-0 group-hover:!opacity-100 hover:!opacity-100'}
        `}
        style={{ width: '12px', height: '12px', right: '-6px', top: '50%', transform: 'translateY(-50%)' }}
      >
        <div className="w-full h-full bg-[#f43f5e] rounded-full transition-transform duration-150 hover:scale-[2.5] hover:shadow-[0_0_12px_rgba(244,63,94,0.6)]" />
      </Handle>
    </div>
  );
}

export default function TableNode({ id, data }: { id: string; data: TableNodeData }) {
  const { t } = useTranslation();
  const { setNodes } = useReactFlow();

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState(data.tableName);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
    }
  }, [isEditingTitle]);

  const handleTitleSave = () => {
    setIsEditingTitle(false);
    if (editTitle.trim() && editTitle !== data.tableName) {
      setNodes((nds) =>
        nds.map((node) => {
          if (node.id === id) {
            return {
              ...node,
              data: {
                ...node.data,
                tableName: editTitle.trim(),
              },
            };
          }
          return node;
        })
      );
    } else {
      setEditTitle(data.tableName);
    }
  };

  const handleUpdateColumn = (oldName: string, newCol: ColumnData) => {
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id === id) {
          const newColumns = (node.data as TableNodeData).columns.map(c => {
            if (c.name === oldName) {
              return newCol;
            }
            // 限制主键只能有一个：如果当前修改的字段被设为主键，则取消其他字段的主键状态
            if (newCol.isPrimary && c.isPrimary) {
              return { ...c, isPrimary: false };
            }
            return c;
          });
          return {
            ...node,
            data: {
              ...node.data,
              columns: newColumns,
            },
          };
        }
        return node;
      })
    );
  };

  return (
    <div className="bg-[#1a1a1a] rounded-lg border border-[#333] shadow-xl overflow-visible min-w-[250px] font-sans">
      {/* Header */}
      <div className="bg-[#2a2a2a] px-4 py-3 border-b border-[#333] rounded-t-lg flex justify-center">
        {isEditingTitle ? (
          <input
            ref={titleInputRef}
            className="bg-[#333] text-gray-200 text-sm font-medium px-2 py-0.5 rounded outline-none border border-[#3794ff] text-center w-full"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={handleTitleSave}
            onKeyDown={(e) => e.key === 'Enter' && handleTitleSave()}
          />
        ) : (
          <h3
            className="text-gray-200 text-sm font-medium text-center m-0 cursor-text hover:bg-[#333] px-2 py-0.5 rounded transition-colors"
            title={`${t('tableNode.tableName')}${data.tableName}${t('tableNode.doubleClickToEdit')}`}
            onDoubleClick={() => setIsEditingTitle(true)}
          >
            {data.tableName}
          </h3>
        )}
      </div>
      {/* Columns */}
      <div className="flex flex-col">
        {data.columns.map((col) => (
          <TableRow key={col.name} col={col} nodeId={id} onUpdateColumn={handleUpdateColumn} />
        ))}
      </div>
    </div>
  );
}