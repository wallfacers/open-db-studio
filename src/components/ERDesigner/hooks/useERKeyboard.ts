import { useEffect, useCallback } from 'react';
import type { Node, Edge } from '@xyflow/react';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import { parseErTableNodeId, parseErEdgeNodeId } from '../../../utils/nodeId';

interface UseERKeyboardOptions {
  nodes: Node[];
  edges: Edge[];
  selectedNodes: Node[];
  selectedEdges: Edge[];
  onAutoLayout: () => void;
  onExportDDL: () => void;
}

/**
 * ER Canvas 键盘快捷键 Hook
 *
 * 快捷键列表:
 * - Delete / Backspace: 删除选中节点或连线
 * - Ctrl+A: 全选
 * - Ctrl+Z: 撤销
 * - Ctrl+Shift+Z: 重做
 * - Ctrl+D: 复制选中表
 * - Ctrl+L: 自动布局
 * - Ctrl+E: 导出 DDL
 */
export function useERKeyboard({
  nodes,
  edges,
  selectedNodes,
  selectedEdges,
  onAutoLayout,
  onExportDDL,
}: UseERKeyboardOptions) {
  const {
    deleteTable,
    deleteRelation,
    undo,
    redo,
    addTable,
    tables,
    activeProjectId,
  } = useErDesignerStore();

  // 删除选中的节点或边
  const handleDelete = useCallback(() => {
    // 删除选中的节点
    selectedNodes.forEach((node) => {
      const tableId = parseErTableNodeId(node.id);
      if (tableId !== null) {
        deleteTable(tableId);
      }
    });

    // 删除选中的边
    selectedEdges.forEach((edge) => {
      const relationId = parseErEdgeNodeId(edge.id);
      if (relationId !== null) {
        deleteRelation(relationId);
      }
    });
  }, [selectedNodes, selectedEdges, deleteTable, deleteRelation]);

  // 复制选中的表
  const handleDuplicate = useCallback(() => {
    if (selectedNodes.length === 0 || !activeProjectId) return;

    selectedNodes.forEach((node) => {
      const tableId = parseErTableNodeId(node.id);
      if (tableId === null) return;
      const originalTable = tables.find((t) => t.id === tableId);
      if (!originalTable) return;

      // 创建新表，位置偏移
      addTable(`${originalTable.name}_copy`, {
        x: originalTable.position_x + 50,
        y: originalTable.position_y + 50,
      });
    });
  }, [selectedNodes, tables, activeProjectId, addTable]);

  // 全选（目前仅支持全选所有节点）
  const handleSelectAll = useCallback(() => {
    // ReactFlow 的全选需要通过 setNodes 实现
    // 这里返回所有节点 ID，由调用方处理
    return nodes.map((n) => n.id);
  }, [nodes]);

  // 键盘事件处理
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isInput = ['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName);
      if (isInput) return;

      // Delete / Backspace: 删除选中
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedNodes.length > 0 || selectedEdges.length > 0) {
          e.preventDefault();
          handleDelete();
        }
        return;
      }

      // Ctrl+A: 全选
      if (e.ctrlKey && e.key === 'a') {
        e.preventDefault();
        handleSelectAll();
        return;
      }

      // Ctrl+Z: 撤销
      if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
        e.preventDefault();
        undo();
        return;
      }

      // Ctrl+Shift+Z: 重做
      if (e.ctrlKey && e.shiftKey && e.key === 'Z') {
        e.preventDefault();
        redo();
        return;
      }

      // Ctrl+D: 复制
      if (e.ctrlKey && e.key === 'd') {
        e.preventDefault();
        handleDuplicate();
        return;
      }

      // Ctrl+L: 自动布局
      if (e.ctrlKey && e.key === 'l') {
        e.preventDefault();
        onAutoLayout();
        return;
      }

      // Ctrl+E: 导出 DDL
      if (e.ctrlKey && e.key === 'e') {
        e.preventDefault();
        onExportDDL();
        return;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    handleDelete,
    handleDuplicate,
    handleSelectAll,
    undo,
    redo,
    onAutoLayout,
    onExportDDL,
    selectedNodes,
    selectedEdges,
  ]);

  return {
    handleDelete,
    handleDuplicate,
    handleSelectAll,
  };
}
