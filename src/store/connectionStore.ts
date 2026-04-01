import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Connection, CreateConnectionRequest, TableMeta } from '../types';

const UI_STATE_KEY_CONNECTIONS = 'opened_connection_ids';

function saveOpenedConnectionIds(ids: Set<number>): void {
  // fire-and-forget，调用方无需 await
  invoke('set_ui_state', {
    key: UI_STATE_KEY_CONNECTIONS,
    value: JSON.stringify([...ids]),
  }).catch(() => {});
}

export async function loadOpenedConnectionIds(): Promise<number[]> {
  try {
    const raw = await invoke<string | null>('get_ui_state', { key: UI_STATE_KEY_CONNECTIONS });
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((id): id is number => typeof id === 'number');
    return [];
  } catch {
    return [];
  }
}

const graphTimers = new Map<number, ReturnType<typeof setInterval>>();

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
  startGraphRefreshTimer: (connectionId: number) => void;
  stopGraphRefreshTimer: (connectionId: number) => void;
  stopAllGraphRefreshTimers: () => void;
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
    // 停止该连接的图刷新定时器
    get().stopGraphRefreshTimer(id);
    set((s) => {
      // 清理已打开连接集合并持久化
      const newActiveIds = new Set(s.activeConnectionIds);
      newActiveIds.delete(id);
      saveOpenedConnectionIds(newActiveIds);
      // 清理元数据缓存
      const { [id]: _, ...restMeta } = s.metaCache;
      return {
        connections: s.connections.filter((c) => c.id !== id),
        activeConnectionId: s.activeConnectionId === id ? null : s.activeConnectionId,
        activeConnectionIds: newActiveIds,
        metaCache: restMeta,
      };
    });
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
        file_path: req.file_path,
        auth_type: req.auth_type,
        token: req.token,
        ssl_mode: req.ssl_mode,
        ssl_ca_path: req.ssl_ca_path,
        ssl_cert_path: req.ssl_cert_path,
        ssl_key_path: req.ssl_key_path,
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
    saveOpenedConnectionIds(newIds);
    return { activeConnectionIds: newIds };
  }),

  closeConnection: (id) => set((s) => {
    const newIds = new Set(s.activeConnectionIds);
    newIds.delete(id);
    saveOpenedConnectionIds(newIds);
    return { activeConnectionIds: newIds };
  }),

  setMeta: (connectionId, meta) =>
    set((s) => ({ metaCache: { ...s.metaCache, [connectionId]: meta } })),

  startGraphRefreshTimer: (connectionId) => {
    if (graphTimers.has(connectionId)) return;
    const timer = setInterval(() => {
      invoke('refresh_schema_graph', { connectionId, database: null }).catch(() => {});
    }, 5 * 60 * 1000);
    graphTimers.set(connectionId, timer);
  },
  stopGraphRefreshTimer: (connectionId) => {
    const timer = graphTimers.get(connectionId);
    if (timer) { clearInterval(timer); graphTimers.delete(connectionId); }
  },
  stopAllGraphRefreshTimers: () => {
    graphTimers.forEach((timer) => clearInterval(timer));
    graphTimers.clear();
  },
}));
