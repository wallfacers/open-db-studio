import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type {
  ErProject,
  ErProjectFull,
  ErTable,
  ErColumn,
  ErRelation,
  ErIndex,
  DiffResult,
} from '../types';

// Operation record for undo/redo (inverse operation model)
interface EntityDelta {
  [key: string]: unknown;
}

interface OperationRecord {
  type:
    | 'add_table'
    | 'delete_table'
    | 'add_column'
    | 'update_column'
    | 'delete_column'
    | 'add_relation'
    | 'delete_relation'
    | 'add_index'
    | 'delete_index'
    | 'move_node'
    | 'update_table'
    | 'batch';
  forward: EntityDelta;
  inverse: EntityDelta;
  timestamp: number;
}

const MAX_UNDO_STACK = 50;

interface ErDesignerState {
  // Project list
  projects: ErProject[];
  loadProjects: () => Promise<void>;
  createProject: (name: string, description?: string) => Promise<ErProject>;
  updateProject: (id: number, updates: Partial<ErProject>) => Promise<void>;
  deleteProject: (id: number) => Promise<void>;

  // Active project data
  activeProjectId: number | null;
  tables: ErTable[];
  columns: Record<number, ErColumn[]>; // tableId → columns
  relations: ErRelation[];
  indexes: Record<number, ErIndex[]>; // tableId → indexes

  // Data loading
  loadProject: (projectId: number) => Promise<void>;

  // Table operations
  addTable: (name: string, position: { x: number; y: number }) => Promise<ErTable>;
  updateTable: (id: number, updates: Partial<ErTable>) => Promise<void>;
  deleteTable: (id: number) => Promise<void>;

  // Column operations
  addColumn: (tableId: number, column: Partial<ErColumn>) => Promise<ErColumn>;
  updateColumn: (id: number, updates: Partial<ErColumn>) => Promise<void>;
  deleteColumn: (id: number, tableId: number) => Promise<void>;
  reorderColumns: (tableId: number, columnIds: number[]) => Promise<void>;

  // Relation operations
  addRelation: (rel: Partial<ErRelation>) => Promise<ErRelation>;
  updateRelation: (id: number, updates: Partial<ErRelation>) => Promise<void>;
  deleteRelation: (id: number) => Promise<void>;

  // Index operations
  addIndex: (tableId: number, index: Partial<ErIndex>) => Promise<ErIndex>;
  updateIndex: (id: number, updates: Partial<ErIndex>) => Promise<void>;
  deleteIndex: (id: number, tableId: number) => Promise<void>;

  // Connection binding
  bindConnection: (projectId: number, connectionId: number, db: string, schema?: string) => Promise<void>;
  unbindConnection: (projectId: number) => Promise<void>;

  // DDL / Diff / Sync
  generateDDL: (
    projectId: number,
    dialect: string,
    options?: { includeIndexes?: boolean; includeComments?: boolean; includeForeignKeys?: boolean }
  ) => Promise<string>;
  diffWithDatabase: (projectId: number) => Promise<DiffResult>;
  syncFromDatabase: (projectId: number, tableNames?: string[]) => Promise<void>;

  // Import/Export
  exportJson: (projectId: number) => Promise<string>;
  importJson: (json: string) => Promise<ErProject>;

  // Undo/Redo
  undoStack: OperationRecord[];
  redoStack: OperationRecord[];
  pushOperation: (op: OperationRecord) => void;
  undo: () => void;
  redo: () => void;
}

/** Helper: apply ErProjectFull to state */
function applyProjectFull(projectFull: ErProjectFull) {
  const columns: Record<number, ErColumn[]> = {};
  const indexes: Record<number, ErIndex[]> = {};
  const tables: ErTable[] = [];

  for (const tf of projectFull.tables) {
    tables.push(tf.table);
    columns[tf.table.id] = tf.columns;
    indexes[tf.table.id] = tf.indexes;
  }

  return {
    activeProjectId: projectFull.project.id,
    tables,
    columns,
    relations: projectFull.relations,
    indexes,
    undoStack: [] as OperationRecord[],
    redoStack: [] as OperationRecord[],
  };
}

export const useErDesignerStore = create<ErDesignerState>((set, get) => ({
  // ── State ──────────────────────────────────────────────────────────────
  projects: [],
  activeProjectId: null,
  tables: [],
  columns: {},
  relations: [],
  indexes: {},
  undoStack: [],
  redoStack: [],

  // ── Project list ───────────────────────────────────────────────────────
  loadProjects: async () => {
    try {
      const projects = await invoke<ErProject[]>('er_list_projects');
      set({ projects });
    } catch (e) {
      console.error('Failed to load ER projects:', e);
    }
  },

  createProject: async (name, description) => {
    try {
      const project = await invoke<ErProject>('er_create_project', {
        req: { name, description: description ?? null },
      });
      set((s) => ({ projects: [...s.projects, project] }));
      return project;
    } catch (e) {
      console.error('Failed to create ER project:', e);
      throw e;
    }
  },

  updateProject: async (id, updates) => {
    try {
      await invoke('er_update_project', { id, req: updates });
      set((s) => ({
        projects: s.projects.map((p) => (p.id === id ? { ...p, ...updates } : p)),
      }));
    } catch (e) {
      console.error('Failed to update ER project:', e);
    }
  },

  deleteProject: async (id) => {
    try {
      await invoke('er_delete_project', { id });
      set((s) => ({
        projects: s.projects.filter((p) => p.id !== id),
        ...(s.activeProjectId === id
          ? { activeProjectId: null, tables: [], columns: {}, relations: [], indexes: {} }
          : {}),
      }));
    } catch (e) {
      console.error('Failed to delete ER project:', e);
    }
  },

  // ── Load project ──────────────────────────────────────────────────────
  loadProject: async (projectId) => {
    try {
      const projectFull = await invoke<ErProjectFull>('er_get_project', { projectId });
      set(applyProjectFull(projectFull));
    } catch (e) {
      console.error('Failed to load ER project:', e);
    }
  },

  // ── Table operations ──────────────────────────────────────────────────
  addTable: async (name, position) => {
    const { activeProjectId, pushOperation } = get();
    try {
      const table = await invoke<ErTable>('er_create_table', {
        req: { project_id: activeProjectId, name, position_x: position.x, position_y: position.y },
      });
      set((s) => ({
        tables: [...s.tables, table],
        columns: { ...s.columns, [table.id]: [] },
        indexes: { ...s.indexes, [table.id]: [] },
      }));
      pushOperation({
        type: 'add_table',
        forward: { tableId: table.id },
        inverse: { tableId: table.id },
        timestamp: Date.now(),
      });
      return table;
    } catch (e) {
      console.error('Failed to add ER table:', e);
      throw e;
    }
  },

  updateTable: async (id, updates) => {
    try {
      await invoke('er_update_table', { id, req: updates });
      set((s) => ({
        tables: s.tables.map((t) => (t.id === id ? { ...t, ...updates } : t)),
      }));
    } catch (e) {
      console.error('Failed to update ER table:', e);
    }
  },

  deleteTable: async (id) => {
    try {
      await invoke('er_delete_table', { id });
      set((s) => {
        const newColumns = { ...s.columns };
        delete newColumns[id];
        const newIndexes = { ...s.indexes };
        delete newIndexes[id];
        return {
          tables: s.tables.filter((t) => t.id !== id),
          columns: newColumns,
          indexes: newIndexes,
          relations: s.relations.filter(
            (r) => r.source_table_id !== id && r.target_table_id !== id
          ),
        };
      });
    } catch (e) {
      console.error('Failed to delete ER table:', e);
    }
  },

  // ── Column operations ─────────────────────────────────────────────────
  addColumn: async (tableId, column) => {
    try {
      const created = await invoke<ErColumn>('er_create_column', {
        req: { table_id: tableId, ...column },
      });
      set((s) => ({
        columns: {
          ...s.columns,
          [tableId]: [...(s.columns[tableId] ?? []), created],
        },
      }));
      return created;
    } catch (e) {
      console.error('Failed to add ER column:', e);
      throw e;
    }
  },

  updateColumn: async (id, updates) => {
    try {
      await invoke('er_update_column', { id, req: updates });
      set((s) => {
        const newColumns = { ...s.columns };
        for (const tableId of Object.keys(newColumns)) {
          const tid = Number(tableId);
          newColumns[tid] = newColumns[tid].map((c) =>
            c.id === id ? { ...c, ...updates } : c
          );
        }
        return { columns: newColumns };
      });
    } catch (e) {
      console.error('Failed to update ER column:', e);
    }
  },

  deleteColumn: async (id, tableId) => {
    try {
      await invoke('er_delete_column', { id });
      set((s) => ({
        columns: {
          ...s.columns,
          [tableId]: (s.columns[tableId] ?? []).filter((c) => c.id !== id),
        },
      }));
    } catch (e) {
      console.error('Failed to delete ER column:', e);
    }
  },

  reorderColumns: async (tableId, columnIds) => {
    try {
      await invoke('er_reorder_columns', { tableId, columnIds });
      // Reload columns for that table by re-sorting based on the provided order
      set((s) => {
        const cols = s.columns[tableId] ?? [];
        const sorted = columnIds
          .map((cid, idx) => {
            const col = cols.find((c) => c.id === cid);
            return col ? { ...col, sort_order: idx } : null;
          })
          .filter((c): c is ErColumn => c !== null);
        return { columns: { ...s.columns, [tableId]: sorted } };
      });
    } catch (e) {
      console.error('Failed to reorder ER columns:', e);
    }
  },

  // ── Relation operations ───────────────────────────────────────────────
  addRelation: async (rel) => {
    const { activeProjectId } = get();
    try {
      const created = await invoke<ErRelation>('er_create_relation', {
        req: { project_id: activeProjectId, ...rel },
      });
      set((s) => ({ relations: [...s.relations, created] }));
      return created;
    } catch (e) {
      console.error('Failed to add ER relation:', e);
      throw e;
    }
  },

  updateRelation: async (id, updates) => {
    try {
      await invoke('er_update_relation', { id, req: updates });
      set((s) => ({
        relations: s.relations.map((r) => (r.id === id ? { ...r, ...updates } : r)),
      }));
    } catch (e) {
      console.error('Failed to update ER relation:', e);
    }
  },

  deleteRelation: async (id) => {
    try {
      await invoke('er_delete_relation', { id });
      set((s) => ({ relations: s.relations.filter((r) => r.id !== id) }));
    } catch (e) {
      console.error('Failed to delete ER relation:', e);
    }
  },

  // ── Index operations ──────────────────────────────────────────────────
  addIndex: async (tableId, index) => {
    try {
      const created = await invoke<ErIndex>('er_create_index', {
        req: { table_id: tableId, ...index },
      });
      set((s) => ({
        indexes: {
          ...s.indexes,
          [tableId]: [...(s.indexes[tableId] ?? []), created],
        },
      }));
      return created;
    } catch (e) {
      console.error('Failed to add ER index:', e);
      throw e;
    }
  },

  updateIndex: async (id, updates) => {
    try {
      await invoke('er_update_index', { id, req: updates });
      set((s) => {
        const newIndexes = { ...s.indexes };
        for (const tableId of Object.keys(newIndexes)) {
          const tid = Number(tableId);
          newIndexes[tid] = newIndexes[tid].map((idx) =>
            idx.id === id ? { ...idx, ...updates } : idx
          );
        }
        return { indexes: newIndexes };
      });
    } catch (e) {
      console.error('Failed to update ER index:', e);
    }
  },

  deleteIndex: async (id, tableId) => {
    try {
      await invoke('er_delete_index', { id });
      set((s) => ({
        indexes: {
          ...s.indexes,
          [tableId]: (s.indexes[tableId] ?? []).filter((idx) => idx.id !== id),
        },
      }));
    } catch (e) {
      console.error('Failed to delete ER index:', e);
    }
  },

  // ── Connection binding ────────────────────────────────────────────────
  bindConnection: async (projectId, connectionId, db, schema) => {
    try {
      await invoke('er_bind_connection', {
        projectId,
        req: { connection_id: connectionId, database_name: db, schema_name: schema ?? null },
      });
      await get().loadProject(projectId);
    } catch (e) {
      console.error('Failed to bind connection:', e);
    }
  },

  unbindConnection: async (projectId) => {
    try {
      await invoke('er_unbind_connection', { projectId });
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === projectId
            ? { ...p, connection_id: null, database_name: null, schema_name: null }
            : p
        ),
      }));
    } catch (e) {
      console.error('Failed to unbind connection:', e);
    }
  },

  // ── DDL / Diff / Sync ─────────────────────────────────────────────────
  generateDDL: async (projectId, dialect, options) => {
    try {
      const ddl = await invoke<string>('er_generate_ddl', {
        projectId,
        options: {
          dialect,
          include_indexes: options?.includeIndexes ?? true,
          include_comments: options?.includeComments ?? true,
          include_foreign_keys: options?.includeForeignKeys ?? true,
        },
      });
      return ddl;
    } catch (e) {
      console.error('Failed to generate DDL:', e);
      throw e;
    }
  },

  diffWithDatabase: async (projectId) => {
    try {
      const diff = await invoke<DiffResult>('er_diff_with_database', { projectId });
      return diff;
    } catch (e) {
      console.error('Failed to diff with database:', e);
      throw e;
    }
  },

  syncFromDatabase: async (projectId, tableNames) => {
    try {
      await invoke('er_sync_from_database', { projectId, tableNames: tableNames ?? null });
      await get().loadProject(projectId);
    } catch (e) {
      console.error('Failed to sync from database:', e);
    }
  },

  // ── Import/Export ─────────────────────────────────────────────────────
  exportJson: async (projectId) => {
    try {
      const json = await invoke<string>('er_export_json', { projectId });
      return json;
    } catch (e) {
      console.error('Failed to export ER project:', e);
      throw e;
    }
  },

  importJson: async (json) => {
    try {
      const project = await invoke<ErProject>('er_import_json', { json });
      await get().loadProjects();
      return project;
    } catch (e) {
      console.error('Failed to import ER project:', e);
      throw e;
    }
  },

  // ── Undo/Redo ─────────────────────────────────────────────────────────
  pushOperation: (op) => {
    set((s) => ({
      undoStack: [...s.undoStack.slice(-MAX_UNDO_STACK + 1), op],
      redoStack: [],
    }));
  },

  undo: () => {
    const { undoStack, activeProjectId, loadProject } = get();
    if (undoStack.length === 0 || activeProjectId === null) return;
    const op = undoStack[undoStack.length - 1];
    set((s) => ({
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, op],
    }));
    // Basic stub: reload project to revert state
    loadProject(activeProjectId).catch((e) =>
      console.error('Undo: failed to reload project:', e)
    );
  },

  redo: () => {
    const { redoStack, activeProjectId, loadProject } = get();
    if (redoStack.length === 0 || activeProjectId === null) return;
    const op = redoStack[redoStack.length - 1];
    set((s) => ({
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, op],
    }));
    // Basic stub: reload project to re-apply state
    loadProject(activeProjectId).catch((e) =>
      console.error('Redo: failed to reload project:', e)
    );
  },
}));
