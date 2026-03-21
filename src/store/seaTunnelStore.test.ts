import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('./queryStore', () => ({ useQueryStore: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { useSeaTunnelStore } from './seaTunnelStore';

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
  useSeaTunnelStore.setState({
    nodes: new Map(),
    expandedIds: new Set(),
    selectedId: null,
    isInitializing: false,
    error: null,
  });
});

const CONNECTIONS = [
  { id: 1, name: '生产集群', url: 'http://prod:8080' },
];
const CATEGORIES = [
  { id: 10, name: '数据同步', parent_id: null, connection_id: 1, sort_order: 1 },
  { id: 11, name: '子目录', parent_id: 10, connection_id: null, sort_order: 1 },
];
const JOBS = [
  { id: 100, name: '用户迁移', category_id: 10, connection_id: 1, last_status: null },
  { id: 101, name: '直属作业', category_id: null, connection_id: 1, last_status: 'RUNNING' },
  { id: 102, name: '孤儿作业', category_id: null, connection_id: null, last_status: null },
];

function mockInit() {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === 'list_st_connections') return Promise.resolve(CONNECTIONS);
    if (cmd === 'list_st_categories') return Promise.resolve(CATEGORIES);
    if (cmd === 'list_st_jobs') return Promise.resolve(JOBS);
    if (cmd === 'get_ui_state') return Promise.resolve(null);
    return Promise.resolve(null);
  });
}

describe('init() 树构建', () => {
  it('connection 节点成为根节点（parentId = null）', async () => {
    mockInit();
    await useSeaTunnelStore.getState().init();
    const nodes = useSeaTunnelStore.getState().nodes;
    const connNode = nodes.get('conn_1');
    expect(connNode).toBeDefined();
    expect(connNode!.nodeType).toBe('connection');
    expect(connNode!.parentId).toBeNull();
    expect(connNode!.label).toBe('生产集群');
  });

  it('根目录挂在对应 connection 节点下', async () => {
    mockInit();
    await useSeaTunnelStore.getState().init();
    const nodes = useSeaTunnelStore.getState().nodes;
    const catNode = nodes.get('cat_10');
    expect(catNode!.parentId).toBe('conn_1');
  });

  it('子目录挂在父目录下', async () => {
    mockInit();
    await useSeaTunnelStore.getState().init();
    const nodes = useSeaTunnelStore.getState().nodes;
    const subNode = nodes.get('cat_11');
    expect(subNode!.parentId).toBe('cat_10');
  });

  it('有 category_id 的 Job 挂在对应目录下', async () => {
    mockInit();
    await useSeaTunnelStore.getState().init();
    const nodes = useSeaTunnelStore.getState().nodes;
    const job = nodes.get('job_100');
    expect(job!.parentId).toBe('cat_10');
  });

  it('无 category_id 但有 connection_id 的 Job 直挂集群根节点', async () => {
    mockInit();
    await useSeaTunnelStore.getState().init();
    const nodes = useSeaTunnelStore.getState().nodes;
    const job = nodes.get('job_101');
    expect(job!.parentId).toBe('conn_1');
  });

  it('两者均无的孤儿 Job 不加入树', async () => {
    mockInit();
    await useSeaTunnelStore.getState().init();
    const nodes = useSeaTunnelStore.getState().nodes;
    expect(nodes.has('job_102')).toBe(false);
  });
});
