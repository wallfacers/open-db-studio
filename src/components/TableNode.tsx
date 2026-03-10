import { useState, useRef, useEffect } from 'react';
import { Handle, Position, useNodeConnections, useReactFlow } from '@xyflow/react';
import { Key, Diamond } from 'lucide-react';

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
  'INT', 'VARCHAR', 'TEXT', 'DATETIME', 'DATE', 'BOOLEAN', 'DECIMAL', 'FLOAT', 'DOUBLE', 'BIGINT', 'CHAR', 'TIMESTAMP'
];

function TableRow({ col, nodeId, onUpdateColumn }: { col: ColumnData; nodeId: string; onUpdateColumn: (oldName: string, newCol: ColumnData) => void; key?: string }) {
  const sourceConnections = useNodeConnections({ handleType: 'source', handleId: `${col.name}-source` });
  const targetConnections = useNodeConnections({ handleType: 'target', handleId: `${col.name}-target` });

  const isSourceConnected = sourceConnections.length > 0;
  const isTargetConnected = targetConnections.length > 0;

  const [isEditingName, setIsEditingName] = useState(false);
  const [isEditingType, setIsEditingType] = useState(false);
  const [editName, setEditName] = useState(col.name);
  const [editType, setEditType] = useState(col.type);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const typeSelectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, [isEditingName]);

  useEffect(() => {
    if (isEditingType && typeSelectRef.current) {
      typeSelectRef.current.focus();
    }
  }, [isEditingType]);

  const handleNameSave = () => {
    setIsEditingName(false);
    if (editName.trim() && editName !== col.name) {
      onUpdateColumn(col.name, { ...col, name: editName.trim() });
    } else {
      setEditName(col.name);
    }
  };

  const handleTypeSave = () => {
    setIsEditingType(false);
    if (editType && editType !== col.type) {
      onUpdateColumn(col.name, { ...col, type: editType });
    } else {
      setEditType(col.type);
    }
  };

  return (
    <div
      className={`flex items-center justify-between px-4 py-2 border-b border-[#333] last:border-b-0 relative group hover:bg-[#222] transition-colors h-[32px] ${isEditingType ? 'z-[99999]' : ''}`}
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
        {/* PK/FK Toggle Icon */}
        <div 
          className="w-4 h-4 flex items-center justify-center cursor-pointer opacity-50 hover:opacity-100 transition-opacity"
          title={col.isPrimary ? "点击取消主键" : col.isForeign ? "点击取消外键" : "点击设置为主键 (再点设为外键)"}
          onClick={() => {
            if (col.isPrimary) {
              onUpdateColumn(col.name, { ...col, isPrimary: false, isForeign: true });
            } else if (col.isForeign) {
              onUpdateColumn(col.name, { ...col, isPrimary: false, isForeign: false });
            } else {
              onUpdateColumn(col.name, { ...col, isPrimary: true, isForeign: false });
            }
          }}
        >
          {col.isPrimary ? (
            <Key className="w-3.5 h-3.5 text-[#eab308] opacity-100" />
          ) : col.isForeign ? (
            <Key className="w-3.5 h-3.5 text-gray-400 opacity-100" />
          ) : (
            <Key className="w-3.5 h-3.5 text-gray-600 opacity-0 group-hover:opacity-100" /> 
          )}
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
            title={col.name}
            onDoubleClick={() => setIsEditingName(true)}
          >
            {col.name}
          </span>
        )}
      </div>

      {/* Column Type */}
      <div className="z-0 flex-1 flex justify-end items-center relative">
        {isEditingType ? (
          <div className="nodrag nowheel absolute right-0 top-0 mt-6 bg-[#252526] border border-[#3c3c3c] rounded shadow-2xl z-[99999] py-1 min-w-[120px] cursor-default">
            {commonSqlTypes.map(type => (
              <div 
                key={type} 
                className="px-3 py-1.5 hover:bg-[#37373d] cursor-pointer text-[#d4d4d4] text-xs font-mono"
                onClick={() => {
                  setEditType(type);
                  onUpdateColumn(col.name, { ...col, type });
                  setIsEditingType(false);
                }}
              >
                {type}
              </div>
            ))}
          </div>
        ) : null}

        {/* We keep the span always visible, but click triggers the menu */}
        <span 
          className={`text-gray-500 text-xs font-mono cursor-pointer hover:bg-[#333] px-1 py-0.5 -mx-1 rounded ${isEditingType ? 'bg-[#333] border border-[#3794ff]' : ''}`}
          onDoubleClick={() => setIsEditingType(true)}
          onClick={() => { if(isEditingType) setIsEditingType(false); }}
        >
          {col.type}
        </span>

        {/* Invisible overlay to close menu when clicking outside (Viewport level) */}
        {isEditingType && (
          <div className="fixed top-0 left-0 w-screen h-screen z-[99998] cursor-default" onClick={(e) => { e.stopPropagation(); setIsEditingType(false); }} />
        )}
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
            // If the updated column is set as Primary Key, unset Primary Key for all other columns
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