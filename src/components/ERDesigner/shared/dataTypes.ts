import type { ErColumn } from '@/types';

export interface DataTypeDefinition {
  name: string;
  category: 'numeric' | 'string' | 'datetime' | 'binary' | 'json' | 'spatial' | 'other';
  hasLength: boolean;
  hasScale: boolean;
  hasUnsigned: boolean;
  hasEnumValues: boolean;
  defaultLength: number | null;
  defaultScale: number | null;
}

export type DialectName = 'mysql' | 'postgresql' | 'oracle' | 'sqlserver' | 'sqlite';

function n(name: string, opts: Partial<DataTypeDefinition> = {}): DataTypeDefinition {
  return {
    name,
    category: opts.category ?? 'other',
    hasLength: opts.hasLength ?? false,
    hasScale: opts.hasScale ?? false,
    hasUnsigned: opts.hasUnsigned ?? false,
    hasEnumValues: opts.hasEnumValues ?? false,
    defaultLength: opts.defaultLength ?? null,
    defaultScale: opts.defaultScale ?? null,
  };
}

export const DIALECT_TYPES: Record<DialectName, DataTypeDefinition[]> = {
  mysql: [
    // Numeric
    n('TINYINT',    { category: 'numeric', hasUnsigned: true }),
    n('SMALLINT',   { category: 'numeric', hasUnsigned: true }),
    n('MEDIUMINT',  { category: 'numeric', hasUnsigned: true }),
    n('INT',        { category: 'numeric', hasUnsigned: true }),
    n('BIGINT',     { category: 'numeric', hasUnsigned: true }),
    n('DECIMAL',    { category: 'numeric', hasLength: true, hasScale: true, hasUnsigned: true, defaultLength: 10, defaultScale: 2 }),
    n('FLOAT',      { category: 'numeric', hasUnsigned: true }),
    n('DOUBLE',     { category: 'numeric', hasUnsigned: true }),
    n('BOOLEAN',    { category: 'numeric' }),
    // String
    n('CHAR',       { category: 'string', hasLength: true, defaultLength: 1 }),
    n('VARCHAR',    { category: 'string', hasLength: true, defaultLength: 255 }),
    n('TINYTEXT',   { category: 'string' }),
    n('TEXT',       { category: 'string' }),
    n('MEDIUMTEXT', { category: 'string' }),
    n('LONGTEXT',   { category: 'string' }),
    n('ENUM',       { category: 'string', hasEnumValues: true }),
    n('SET',        { category: 'string', hasEnumValues: true }),
    // Datetime
    n('DATE',       { category: 'datetime' }),
    n('DATETIME',   { category: 'datetime' }),
    n('TIMESTAMP',  { category: 'datetime' }),
    n('TIME',       { category: 'datetime' }),
    // Binary
    n('BINARY',     { category: 'binary', hasLength: true, defaultLength: 1 }),
    n('VARBINARY',  { category: 'binary', hasLength: true, defaultLength: 255 }),
    n('BLOB',       { category: 'binary' }),
    // JSON
    n('JSON',       { category: 'json' }),
  ],

  postgresql: [
    // Numeric
    n('SMALLINT',         { category: 'numeric' }),
    n('INTEGER',          { category: 'numeric' }),
    n('BIGINT',           { category: 'numeric' }),
    n('SERIAL',           { category: 'numeric' }),
    n('BIGSERIAL',        { category: 'numeric' }),
    n('NUMERIC',          { category: 'numeric', hasLength: true, hasScale: true, defaultLength: 10, defaultScale: 2 }),
    n('REAL',             { category: 'numeric' }),
    n('DOUBLE PRECISION', { category: 'numeric' }),
    n('MONEY',            { category: 'numeric' }),
    // String
    n('CHAR',             { category: 'string', hasLength: true, defaultLength: 1 }),
    n('VARCHAR',          { category: 'string', hasLength: true, defaultLength: 255 }),
    n('TEXT',             { category: 'string' }),
    // Datetime
    n('DATE',             { category: 'datetime' }),
    n('TIMESTAMP',        { category: 'datetime' }),
    n('TIME',             { category: 'datetime' }),
    n('INTERVAL',         { category: 'datetime' }),
    // Binary
    n('BYTEA',            { category: 'binary' }),
    // JSON
    n('JSON',             { category: 'json' }),
    n('JSONB',            { category: 'json' }),
    // Other
    n('BOOLEAN',          { category: 'other' }),
    n('UUID',             { category: 'other' }),
  ],

  oracle: [
    // Numeric
    n('NUMBER',    { category: 'numeric', hasLength: true, hasScale: true, defaultLength: 10, defaultScale: 0 }),
    n('FLOAT',     { category: 'numeric' }),
    // String
    n('CHAR',      { category: 'string', hasLength: true, defaultLength: 1 }),
    n('VARCHAR2',  { category: 'string', hasLength: true, defaultLength: 255 }),
    n('NVARCHAR2', { category: 'string', hasLength: true, defaultLength: 255 }),
    n('CLOB',      { category: 'string' }),
    n('NCLOB',     { category: 'string' }),
    // Datetime
    n('DATE',      { category: 'datetime' }),
    n('TIMESTAMP', { category: 'datetime' }),
    // Binary
    n('BLOB',      { category: 'binary' }),
    n('RAW',       { category: 'binary', hasLength: true, defaultLength: 2000 }),
  ],

  sqlserver: [
    // Numeric
    n('TINYINT',            { category: 'numeric' }),
    n('SMALLINT',           { category: 'numeric' }),
    n('INT',                { category: 'numeric' }),
    n('BIGINT',             { category: 'numeric' }),
    n('DECIMAL',            { category: 'numeric', hasLength: true, hasScale: true, defaultLength: 18, defaultScale: 0 }),
    n('MONEY',              { category: 'numeric' }),
    n('FLOAT',              { category: 'numeric' }),
    n('BIT',                { category: 'numeric' }),
    // String
    n('CHAR',               { category: 'string', hasLength: true, defaultLength: 1 }),
    n('VARCHAR',            { category: 'string', hasLength: true, defaultLength: 255 }),
    n('NCHAR',              { category: 'string', hasLength: true, defaultLength: 1 }),
    n('NVARCHAR',           { category: 'string', hasLength: true, defaultLength: 255 }),
    n('TEXT',               { category: 'string' }),
    n('NTEXT',              { category: 'string' }),
    // Datetime
    n('DATE',               { category: 'datetime' }),
    n('DATETIME2',          { category: 'datetime' }),
    n('TIME',               { category: 'datetime' }),
    // Binary
    n('VARBINARY',          { category: 'binary', hasLength: true, defaultLength: 255 }),
    // Other
    n('UNIQUEIDENTIFIER',   { category: 'other' }),
  ],

  sqlite: [
    n('INTEGER',  { category: 'numeric' }),
    n('REAL',     { category: 'numeric' }),
    n('TEXT',     { category: 'string' }),
    n('BLOB',     { category: 'binary' }),
    n('NUMERIC',  { category: 'numeric', hasLength: true, hasScale: true, defaultLength: 10, defaultScale: 2 }),
    n('BOOLEAN',  { category: 'other' }),
  ],
};

/** Get type options for a dialect; if null, return union of all dialects */
export function getTypeOptions(dialect: DialectName | null): { value: string; label: string; category: string }[] {
  if (dialect) {
    return (DIALECT_TYPES[dialect] || []).map(t => ({
      value: t.name, label: t.name, category: t.category,
    }));
  }
  const seen = new Set<string>();
  const result: { value: string; label: string; category: string }[] = [];
  for (const types of Object.values(DIALECT_TYPES)) {
    for (const t of types) {
      if (!seen.has(t.name)) {
        seen.add(t.name);
        result.push({ value: t.name, label: t.name, category: t.category });
      }
    }
  }
  return result;
}

/** Strip UNSIGNED qualifier from a type string */
export function stripUnsigned(type: string): string {
  return type.replace(/\s+UNSIGNED$/i, '').trim();
}

/** Find type definition by name */
export function findTypeDef(typeName: string, dialect: DialectName | null): DataTypeDefinition | undefined {
  const upper = stripUnsigned(typeName).toUpperCase();
  if (dialect) {
    return DIALECT_TYPES[dialect]?.find(t => t.name === upper);
  }
  for (const types of Object.values(DIALECT_TYPES)) {
    const found = types.find(t => t.name === upper);
    if (found) return found;
  }
  return undefined;
}

/** Format type display text */
export function formatTypeDisplay(column: Pick<ErColumn, 'data_type' | 'length' | 'scale'>): string {
  const { data_type, length, scale } = column;
  const baseType = stripUnsigned(data_type);
  let result = baseType;
  if (length != null && scale != null) result = `${baseType}(${length},${scale})`;
  else if (length != null) result = `${baseType}(${length})`;
  return result;
}

/** Check type compatibility with a dialect; returns warning message or null */
export function checkTypeCompatibility(typeName: string, dialect: DialectName): string | null {
  const upper = typeName.toUpperCase();
  const types = DIALECT_TYPES[dialect];
  if (!types) return null;
  if (types.some(t => t.name === upper)) return null;

  const suggestions: Record<string, Record<string, string>> = {
    mysql:      { JSONB: 'JSON', SERIAL: 'INT + AUTO_INCREMENT', UUID: 'CHAR(36)', BYTEA: 'BLOB' },
    postgresql: { TINYINT: 'SMALLINT', MEDIUMINT: 'INTEGER', DOUBLE: 'DOUBLE PRECISION', DATETIME: 'TIMESTAMP', ENUM: 'TEXT + CHECK' },
    oracle:     { BOOLEAN: 'NUMBER(1)', VARCHAR: 'VARCHAR2', TEXT: 'CLOB', JSON: 'CLOB', BIGINT: 'NUMBER(19)' },
    sqlserver:  { BOOLEAN: 'BIT', TEXT: 'NVARCHAR(MAX)', TIMESTAMP: 'DATETIME2', SERIAL: 'INT IDENTITY' },
    sqlite:     { VARCHAR: 'TEXT', DATETIME: 'TEXT', BOOLEAN: 'INTEGER' },
  };

  const suggestion = suggestions[dialect]?.[upper];
  if (suggestion) return `${typeName} 不是 ${dialect} 支持的类型，建议改为 ${suggestion}`;
  return `${typeName} 不是 ${dialect} 支持的类型`;
}
