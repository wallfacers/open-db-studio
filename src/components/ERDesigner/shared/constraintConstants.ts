/**
 * Shared constants for constraint method / comment format resolution.
 * Single source of truth for labels, badges, and option lists.
 */

// ── Union types ──────────────────────────────────────────────────────

export type ConstraintMethod = 'database_fk' | 'comment_ref';
export type CommentFormat = '@ref' | '@fk' | '[ref]' | '$$ref$$';

// ── Badge map ────────────────────────────────────────────────────────

export const CONSTRAINT_BADGE: Record<string, string> = {
  database_fk: '🔒',
  comment_ref: '💬',
};

// ── Labels ───────────────────────────────────────────────────────────

export const CONSTRAINT_METHOD_LABELS: Record<string, string> = {
  database_fk: '数据库外键 🔒',
  comment_ref: '注释引用 💬',
};

// ── Option lists (for dropdowns / selects) ───────────────────────────

/** Full option list including "inherit" sentinel (used by EREdge dropdown). */
export const CONSTRAINT_METHOD_OPTIONS = [
  { value: '', label: '继承默认' },
  { value: 'database_fk', label: '数据库外键 🔒' },
  { value: 'comment_ref', label: '注释引用 💬' },
] as const;

/** Full option list including "inherit" sentinel (used by EREdge dropdown). */
export const COMMENT_FORMAT_OPTIONS = [
  { value: '', label: '继承默认' },
  { value: '@ref', label: '@ref:table.col' },
  { value: '@fk', label: '@fk(table,col,type)' },
  { value: '[ref]', label: '[ref:table.col]' },
  { value: '$$ref$$', label: '$$ref(table.col)$$' },
] as const;

/** Base format values without "inherit" sentinel (used by select <option> lists). */
export const COMMENT_FORMAT_VALUES = [
  { value: '@ref', label: '@ref:table.col' },
  { value: '@fk', label: '@fk(table,col,type)' },
  { value: '[ref]', label: '[ref:table.col]' },
  { value: '$$ref$$', label: '$$ref(table.col)$$' },
] as const;

// ── Defaults ─────────────────────────────────────────────────────────

export const DEFAULT_CONSTRAINT_METHOD: ConstraintMethod = 'database_fk';
export const DEFAULT_COMMENT_FORMAT: CommentFormat = '@ref';
