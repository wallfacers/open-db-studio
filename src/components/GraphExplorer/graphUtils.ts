export function parseAliases(aliases: string): string[] {
  if (!aliases || !aliases.trim()) return [];
  try {
    const parsed = JSON.parse(aliases);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
  } catch {
    // fallback: split by comma/whitespace
  }
  return aliases
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 根据边的 source 返回样式
export function getEdgeStyleBySource(source: string): { stroke?: string; strokeDasharray?: string } {
  switch (source) {
    case 'comment':
      return { stroke: '#f59e0b', strokeDasharray: '5,3' };
    case 'user':
      return { stroke: 'var(--edge-alias)', strokeDasharray: '2,2' };
    case 'schema':
    default:
      return { stroke: 'var(--edge-fk)' };
  }
}

// 根据 source 返回来源徽章信息
export function getSourceBadge(source: string): { label: string; color: string } {
  switch (source) {
    case 'comment': return { label: '注释推断', color: 'var(--edge-reference)' };
    case 'user':    return { label: '用户自定义', color: 'var(--edge-alias)' };
    default:        return { label: '数据库外键', color: 'var(--edge-fk)' };
  }
}
