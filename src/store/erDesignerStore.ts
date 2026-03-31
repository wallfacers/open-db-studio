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
import { checkTypeCompatibility, type DialectName } from '@/components/ERDesigner/shared/dataTypes';

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

const PERSIST_KEY_EXPANDED = 'er_sidebar_expanded';

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

  // Sidebar expansion persistence
  expandedProjects: Set<number>;
  expandedTables: Set<number>;
  toggleProjectExpand: (projectId: number) => void;
  toggleTableExpand: (tableId: number) => void;
  restoreExpandedState: () => Promise<void>;

  // Table operations
  addTable: (name: string, position: { x: number; y: number }) => Promise<ErTable>;
  updateTable: (id: number, updates: Partial<ErTable>) => Promise<void>;
  updateTablePositions: (positions: { id: number; x: number; y: number }[]) => Promise<void>;
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

  // 抽屉面板状态
  drawerOpen: boolean;
  drawerTableId: number | null;
  drawerFocusColumnId: number | null;
  openDrawer: (tableId: number, focusColumnId?: number) => void;
  closeDrawer: () => void;

  // 方言兼容性
  boundDialect: string | null;
  dialectWarnings: Record<number, string>;
  checkDialectCompatibility: () => void;
  checkColumnCompatibility: (columnId: number) => void;
  clearDialectWarnings: () => void;
}

/** Helper: apply ErProjectFull to state */
function applyProjectFull(projectFull: ErProjectFull) {
  const columns: Record<number, ErColumn[]> = {};
  const indexes: Record<number, ErIndex[]> = {};
  const tables: ErTable[] = [];

  for (const tf of projectFull.tables) {
    tables.push(tf.table);
    columns[tf.table.id] = tf.columns.map((col: any) => ({
      ...col,
      enum_values: col.enum_values ? JSON.parse(col.enum_values) : null,
    }));
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

/** Debounced persist for expanded state */
let _persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistExpandedState(expandedProjects: Set<number>, expandedTables: Set<number>): void {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    invoke('set_ui_state', {
      key: PERSIST_KEY_EXPANDED,
      value: JSON.stringify({
        projects: [...expandedProjects],
        tables: [...expandedTables],
      }),
    }).catch(() => {});
  }, 500);
}

export const useErDesignerStore = create<ErDesignerState>((set, get) => ({
  // ── State ──────────────────────────────────────────────────────────────
  projects: [],
  activeProjectId: null,
  tables: [],
  columns: {},
  relations: [],
  indexes: {},
  expandedProjects: new Set<number>(),
  expandedTables: new Set<number>(),
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
      set((s) => {
        const expandedProjects = new Set(s.expandedProjects);
        expandedProjects.delete(id);
        // Remove table expansions belonging to deleted project's tables
        const tableIdsToRemove = new Set(s.tables.filter(t => t.project_id === id).map(t => t.id));
        const expandedTables = new Set(s.expandedTables);
        for (const tid of tableIdsToRemove) expandedTables.delete(tid);
        persistExpandedState(expandedProjects, expandedTables);
        return {
          projects: s.projects.filter((p) => p.id !== id),
          expandedProjects,
          expandedTables,
          ...(s.activeProjectId === id
            ? { activeProjectId: null, tables: [], columns: {}, relations: [], indexes: {} }
            : {}),
        };
      });
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

  // ── Sidebar expansion persistence ─────────────────────────────────────
  toggleProjectExpand: (projectId) => {
    set((s) => {
      const next = new Set(s.expandedProjects);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
        // Load project data when expanding
        get().loadProject(projectId);
      }
      persistExpandedState(next, s.expandedTables);
      return { expandedProjects: next };
    });
  },

  toggleTableExpand: (tableId) => {
    set((s) => {
      const next = new Set(s.expandedTables);
      if (next.has(tableId)) {
        next.delete(tableId);
      } else {
        next.add(tableId);
      }
      persistExpandedState(s.expandedProjects, next);
      return { expandedTables: next };
    });
  },

  restoreExpandedState: async () => {
    try {
      const raw = await invoke<string | null>('get_ui_state', { key: PERSIST_KEY_EXPANDED });
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const projects = Array.isArray(parsed.projects)
          ? new Set<number>(parsed.projects.filter((id: unknown): id is number => typeof id === 'number'))
          : new Set<number>();
        const tables = Array.isArray(parsed.tables)
          ? new Set<number>(parsed.tables.filter((id: unknown): id is number => typeof id === 'number'))
          : new Set<number>();
        set({ expandedProjects: projects, expandedTables: tables });
        // Pre-load expanded projects' data
        for (const projectId of projects) {
          get().loadProject(projectId);
        }
      }
    } catch {
      // Silently ignore — non-critical UI state
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

  updateTablePositions: async (positions) => {
    set((s) => {
      const posMap = new Map(positions.map((p) => [p.id, p]));
      return {
        tables: s.tables.map((t) => {
          const p = posMap.get(t.id);
          return p ? { ...t, position_x: p.x, position_y: p.y } : t;
        }),
      };
    });
    try {
      await Promise.all(
        positions.map((p) =>
          invoke('er_update_table', {
            id: p.id,
            req: { position_x: p.x, position_y: p.y },
          })
        )
      );
    } catch (e) {
      console.error('Failed to save auto layout positions:', e);
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
        const expandedTables = new Set(s.expandedTables);
        expandedTables.delete(id);
        persistExpandedState(s.expandedProjects, expandedTables);
        return {
          tables: s.tables.filter((t) => t.id !== id),
          columns: newColumns,
          indexes: newIndexes,
          expandedTables,
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
      // Serialize enum_values to JSON string for Rust
      const req: any = { table_id: tableId, ...column };
      if (req.enum_values != null) {
        req.enum_values = JSON.stringify(req.enum_values);
      }
      const created = await invoke<ErColumn>('er_create_column', { req });
      // Deserialize enum_values from Rust
      const deserialized: ErColumn = {
        ...created,
        enum_values: (created as any).enum_values
          ? JSON.parse((created as any).enum_values)
          : null,
      };
      set((s) => ({
        columns: {
          ...s.columns,
          [tableId]: [...(s.columns[tableId] ?? []), deserialized],
        },
      }));
      return deserialized;
    } catch (e) {
      console.error('Failed to add ER column:', e);
      throw e;
    }
  },

  updateColumn: async (id, updates) => {
    try {
      // When removing primary key, also clear auto_increment
      if (updates.is_primary_key === false) {
        updates = { ...updates, is_auto_increment: false };
      }
      // When setting primary key, clear PK (and auto_increment) from other columns in the same table
      if (updates.is_primary_key === true) {
        const state = get();
        for (const tableId of Object.keys(state.columns)) {
          const cols = state.columns[Number(tableId)];
          const target = cols?.find((c) => c.id === id);
          if (target) {
            const otherPks = cols.filter((c) => c.id !== id && c.is_primary_key);
            for (const pk of otherPks) {
              const clearReq: any = { is_primary_key: false, is_auto_increment: false };
              await invoke('er_update_column', { id: pk.id, req: clearReq });
            }
            if (otherPks.length > 0) {
              set((s) => {
                const newColumns = { ...s.columns };
                const tid = Number(tableId);
                newColumns[tid] = newColumns[tid].map((c) =>
                  c.id !== id && c.is_primary_key
                    ? { ...c, is_primary_key: false, is_auto_increment: false }
                    : c
                );
                return { columns: newColumns };
              });
            }
            break;
          }
        }
      }
      // Serialize enum_values to JSON string for Rust
      const req: any = { ...updates };
      if (req.enum_values !== undefined && req.enum_values != null) {
        req.enum_values = JSON.stringify(req.enum_values);
      }
      await invoke('er_update_column', { id, req });
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
      get().checkColumnCompatibility(id);
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
      set((s) => {
        const next = { ...s.dialectWarnings };
        delete next[id];
        return { dialectWarnings: next };
      });
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

  // ── Drawer panel state ───────────────────────────────────────────────
  drawerOpen: false,
  drawerTableId: null,
  drawerFocusColumnId: null,
  openDrawer: (tableId, focusColumnId) => set({
    drawerOpen: true,
    drawerTableId: tableId,
    drawerFocusColumnId: focusColumnId ?? null,
  }),
  closeDrawer: () => set({
    drawerOpen: false,
    drawerTableId: null,
    drawerFocusColumnId: null,
  }),

  // ── Dialect compatibility ─────────────────────────────────────────────
  boundDialect: null,
  dialectWarnings: {},

  checkDialectCompatibility: () => {
    const { boundDialect, columns } = get();
    if (!boundDialect) {
      set({ dialectWarnings: {} });
      return;
    }
    const warnings: Record<number, string> = {};
    for (const cols of Object.values(columns)) {
      for (const col of cols) {
        const w = checkTypeCompatibility(col.data_type, boundDialect as DialectName);
        if (w) warnings[col.id] = w;
      }
    }
    set({ dialectWarnings: warnings });
  },

  checkColumnCompatibility: (columnId: number) => {
    const { boundDialect, columns, dialectWarnings } = get();
    if (!boundDialect) return;
    for (const cols of Object.values(columns)) {
      const col = cols.find(c => c.id === columnId);
      if (col) {
        const w = checkTypeCompatibility(col.data_type, boundDialect as DialectName);
        const next = { ...dialectWarnings };
        if (w) next[columnId] = w; else delete next[columnId];
        set({ dialectWarnings: next });
        break;
      }
    }
  },

  clearDialectWarnings: () => set({ dialectWarnings: {} }),
}));
