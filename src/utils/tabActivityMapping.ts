import type { TabType, Tab } from '../types';
import { connNodeId, dbNodeId, schemaNodeId, catNodeId, objectNodeId } from './nodeId';

/** Tab 类型 → ActivityBar activity 键 */
export function tabTypeToActivity(tabType: TabType): string | null {
  switch (tabType) {
    case 'query':
    case 'table':
    case 'table_structure':
    case 'metric':
    case 'metric_list':
      return 'database';
    case 'er_design':
      return 'er_designer';
    case 'seatunnel_job':
      return 'seatunnel';
    default:
      return null;
  }
}

/** 从 Tab 元数据反推主树节点 ID（仅 database activity 的 table/table_structure） */
export function tabToTreeNodeId(tab: Tab): string | null {
  if (tab.type !== 'table' && tab.type !== 'table_structure') return null;
  const connId = tab.connectionId;
  if (connId == null) return null;
  if (tab.type === 'table_structure' && tab.id.includes('_new_')) return null;

  let parentId = connNodeId(connId);
  if (tab.db && !tab.db.startsWith('conn_')) {
    parentId = dbNodeId(parentId, tab.db);
  }
  if (tab.schema) {
    parentId = schemaNodeId(parentId, tab.schema);
  }
  const catId = catNodeId(parentId, 'tables');
  return objectNodeId(catId, 'table', tab.title);
}
