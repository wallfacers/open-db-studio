export interface IndexColumnEntry {
  name: string;
  order: 'ASC' | 'DESC';
}

export function parseIndexColumns(json: string): IndexColumnEntry[] {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.map(item =>
        typeof item === 'string'
          ? { name: item, order: 'ASC' as const }
          : { name: item.name ?? item, order: item.order ?? 'ASC' },
      );
    }
  } catch { /* ignore */ }
  return [];
}

export function stringifyIndexColumns(entries: IndexColumnEntry[]): string {
  return JSON.stringify(entries);
}
