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
