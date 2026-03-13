import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Connection, CreateConnectionRequest, TableMeta } from '../types';

export interface ConnectionMeta {
  dbVersion: string;
  driver: string;
  host: string;
  port?: number;
  name: string;
}

interface ConnectionState {
  connections: Connection[];
  activeConnectionId: number | null;
  activeConnectionIds: Set<number>; // 所有已打开的连接 ID
  tables: TableMeta[];
  isLoading: boolean;
  error: string | null;
  metaCache: Record<number, ConnectionMeta>;
  setMeta: (connectionId: number, meta: ConnectionMeta) => void;

  loadConnections: () => Promise<void>;
  createConnection: (req: CreateConnectionRequest) => Promise<Connection>;
  deleteConnection: (id: number) => Promise<void>;
  updateConnection: (id: number, req: CreateConnectionRequest) => Promise<Connection>;
  testConnection: (req: CreateConnectionRequest) => Promise<boolean>;
  setActiveConnection: (id: number | null) => void;
  disconnectConnection: (id: number) => void;
  loadTables: (connectionId: number) => Promise<void>;
  // 管理已打开的连接
  openConnection: (id: number) => void;
  closeConnection: (id: number) => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: [],
  activeConnectionId: null,
  activeConnectionIds: new Set<number>(),
  tables: [],
  isLoading: false,
  error: null,
  metaCache: {},

  loadConnections: async () => {
    set({ isLoading: true, error: null });
    try {
      const connections = await invoke<Connection[]>('list_connections');
      set({ connections, isLoading: false });
    } catch (e) {
      set({ error: String(e), isLoading: false });
    }
  },

  createConnection: async (req) => {
    const conn = await invoke<Connection>('create_connection', { req });
    set((s) => ({ connections: [...s.connections, conn] }));
    return conn;
  },

  deleteConnection: async (id) => {
    await invoke('delete_connection', { id });
    set((s) => ({
      connections: s.connections.filter((c) => c.id !== id),
      activeConnectionId: s.activeConnectionId === id ? null : s.activeConnectionId,
    }));
  },

  updateConnection: async (id, req) => {
    const conn = await invoke<Connection>('update_connection', { id, req });
    set((s) => ({
      connections: s.connections.map((c) => (c.id === id ? conn : c)),
    }));
    return conn;
  },

  testConnection: async (req) => {
    return await invoke<boolean>('test_connection', {
      config: {
        driver: req.driver,
        host: req.host ?? '',
        port: req.port ?? 3306,
        database: req.database_name ?? '',
        username: req.username ?? '',
        password: req.password ?? '',
        extra_params: req.extra_params,
      },
    });
  },

  setActiveConnection: (id) => set({ activeConnectionId: id }),

  disconnectConnection: (id) => set((s) => ({
    activeConnectionId: s.activeConnectionId === id ? null : s.activeConnectionId,
    tables: s.activeConnectionId === id ? [] : s.tables,
  })),

  loadTables: async (connectionId) => {
    try {
      const tables = await invoke<TableMeta[]>('get_tables', { connectionId });
      set({ tables });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  openConnection: (id) => set((s) => {
    const newIds = new Set(s.activeConnectionIds);
    newIds.add(id);
    return { activeConnectionIds: newIds };
  }),

  closeConnection: (id) => set((s) => {
    const newIds = new Set(s.activeConnectionIds);
    newIds.delete(id);
    return { activeConnectionIds: newIds };
  }),

  setMeta: (connectionId, meta) =>
    set((s) => ({ metaCache: { ...s.metaCache, [connectionId]: meta } })),
}));
