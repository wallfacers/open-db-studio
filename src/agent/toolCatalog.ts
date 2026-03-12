import { invoke } from '@tauri-apps/api/core';
import type { ToolDefinition, ToolContext, QueryResult } from '../types';
import { useQueryStore } from '../store/queryStore';
import { parseStatements } from '../utils/sqlParser';

// =============================================
// A. 编辑器工具（读 queryStore）
// =============================================

function getEditorTools(): ToolDefinition[] {
  return [
    {
      name: 'get_current_tab',
      description: 'Get the current active SQL editor tab: its id, title, full SQL content, parsed statements with line numbers, and cursor position.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_tab_sql',
      description: 'Get the full SQL content of a specific tab by its id.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'string', description: 'The tab id to read SQL from' },
        },
        required: ['tab_id'],
      },
    },
    {
      name: 'list_tabs',
      description: 'List all open SQL editor tabs (id, title, type).',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'get_selected_text',
      description: 'Get the currently selected text in the active editor, along with start and end line numbers.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'parse_sql_statements',
      description: 'Parse the SQL in the current tab into individual statements, each with text and line numbers.',
      parameters: { type: 'object', properties: {} },
    },
  ];
}

// =============================================
// B. 数据库结构工具（invoke 现有命令）
// =============================================

function getDbStructureTools(): ToolDefinition[] {
  return [
    {
      name: 'list_databases',
      description: 'List all databases available on the current connection.',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'number', description: 'Connection id' },
        },
        required: ['connection_id'],
      },
    },
    {
      name: 'list_tables',
      description: 'List all table names in a database (and optionally a schema).',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'number', description: 'Connection id' },
          database: { type: 'string', description: 'Database name' },
          schema: { type: 'string', description: 'Schema name (optional, for PostgreSQL/Oracle)' },
        },
        required: ['connection_id', 'database'],
      },
    },
    {
      name: 'get_table_schema',
      description: 'Get detailed schema for a table: columns (name, type, nullable, default, primary key), indexes, and foreign keys.',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'number', description: 'Connection id' },
          table: { type: 'string', description: 'Table name' },
          schema: { type: 'string', description: 'Schema name (optional)' },
          database: { type: 'string', description: 'Database name (optional, used for multi-database connections)' },
        },
        required: ['connection_id', 'table'],
      },
    },
    {
      name: 'list_views',
      description: 'List all view names in a database.',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'number', description: 'Connection id' },
          database: { type: 'string', description: 'Database name' },
        },
        required: ['connection_id', 'database'],
      },
    },
    {
      name: 'list_procedures',
      description: 'List all stored procedure and function names in a database.',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'number', description: 'Connection id' },
          database: { type: 'string', description: 'Database name' },
        },
        required: ['connection_id', 'database'],
      },
    },
  ];
}

// =============================================
// C. 数据工具（新建受限 invoke 命令）
// =============================================

function getDataTools(): ToolDefinition[] {
  return [
    {
      name: 'get_table_sample',
      description: 'Fetch a sample of rows from a table (max 20 rows) to understand the data format.',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'number', description: 'Connection id' },
          table: { type: 'string', description: 'Table name' },
          schema: { type: 'string', description: 'Schema name (optional)' },
          limit: { type: 'number', description: 'Max rows to return, capped at 20' },
        },
        required: ['connection_id', 'table'],
      },
    },
    {
      name: 'execute_sql',
      description: 'Execute a read-only SQL query (SELECT/WITH/SHOW only). Returns at most 100 rows.',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'number', description: 'Connection id' },
          sql: { type: 'string', description: 'SQL query to execute (SELECT/WITH/SHOW only)' },
          database: { type: 'string', description: 'Database context (optional)' },
        },
        required: ['connection_id', 'sql'],
      },
    },
    {
      name: 'get_last_error',
      description: 'Get the most recent SQL execution error message from the current session.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'get_query_history',
      description: 'Get recently executed SQL statements for the current connection (max 50).',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'number', description: 'Connection id' },
          limit: { type: 'number', description: 'Number of records to return, max 50' },
        },
        required: ['connection_id'],
      },
    },
  ];
}

// =============================================
// D. 写回工具（操作编辑器）
// =============================================

function getWriteBackTools(): ToolDefinition[] {
  return [
    {
      name: 'propose_sql_diff',
      description: 'Propose a SQL change: show the user a diff preview and wait for them to confirm before applying to the editor.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'string', description: 'Tab id to modify' },
          original: { type: 'string', description: 'The original SQL text to replace' },
          modified: { type: 'string', description: 'The new SQL text' },
          reason: { type: 'string', description: 'Brief explanation of what changed and why' },
        },
        required: ['tab_id', 'original', 'modified', 'reason'],
      },
    },
    {
      name: 'switch_tab',
      description: 'Switch the active editor tab.',
      parameters: {
        type: 'object',
        properties: {
          tab_id: { type: 'string', description: 'The tab id to switch to' },
        },
        required: ['tab_id'],
      },
    },
  ];
}

export function getToolDefinitions(): ToolDefinition[] {
  return [
    ...getEditorTools(),
    ...getDbStructureTools(),
    ...getDataTools(),
    ...getWriteBackTools(),
  ];
}

// =============================================
// Tool Executor — 根据 name 分发执行
// =============================================

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  _context: ToolContext
): Promise<string> {
  const store = useQueryStore.getState();

  try {
    switch (name) {
      // -- A: Editor tools --
      case 'get_current_tab': {
        const tabId = store.activeTabId;
        const sql = store.sqlContent[tabId] ?? '';
        const editorInfo = store.editorInfo[tabId];
        const statements = parseStatements(sql);
        return JSON.stringify({
          tabId,
          title: store.tabs.find(t => t.id === tabId)?.title ?? tabId,
          sql,
          statements,
          cursorLine: editorInfo?.cursorLine ?? 0,
        });
      }

      case 'get_tab_sql': {
        const tabId = String(args.tab_id ?? '');
        return JSON.stringify({ tabId, sql: store.sqlContent[tabId] ?? '' });
      }

      case 'list_tabs': {
        return JSON.stringify(store.tabs.map(t => ({ id: t.id, title: t.title, type: t.type })));
      }

      case 'get_selected_text': {
        const tabId = store.activeTabId;
        const editorInfo = store.editorInfo[tabId];
        return JSON.stringify({
          text: editorInfo?.selectedText ?? '',
          startLine: editorInfo?.selectionStartLine ?? 0,
          endLine: editorInfo?.selectionEndLine ?? 0,
        });
      }

      case 'parse_sql_statements': {
        const sql = store.sqlContent[store.activeTabId] ?? '';
        return JSON.stringify(parseStatements(sql));
      }

      // -- B: Database structure tools --
      case 'list_databases': {
        const result = await invoke<string[]>('list_databases', { connectionId: args.connection_id });
        return JSON.stringify(result);
      }

      case 'list_tables': {
        const result = await invoke<string[]>('list_objects', {
          connectionId: args.connection_id,
          database: args.database,
          schema: args.schema ?? null,
          category: 'tables',
        });
        return JSON.stringify(result);
      }

      case 'get_table_schema': {
        const result = await invoke('get_table_detail', {
          connectionId: args.connection_id,
          table: args.table,
          schema: args.schema ?? null,
          database: args.database ?? null,
        });
        return JSON.stringify(result);
      }

      case 'list_views': {
        const result = await invoke<string[]>('list_objects', {
          connectionId: args.connection_id,
          database: args.database,
          schema: null,
          category: 'views',
        });
        return JSON.stringify(result);
      }

      case 'list_procedures': {
        const result = await invoke<string[]>('list_objects', {
          connectionId: args.connection_id,
          database: args.database,
          schema: null,
          category: 'procedures',
        });
        return JSON.stringify(result);
      }

      // -- C: Data tools --
      case 'get_table_sample': {
        const result = await invoke<QueryResult>('agent_get_table_sample', {
          connectionId: args.connection_id,
          table: args.table,
          schema: args.schema ?? null,
          limit: args.limit ?? 5,
        });
        return JSON.stringify(result);
      }

      case 'execute_sql': {
        const result = await invoke<QueryResult>('agent_execute_sql', {
          connectionId: args.connection_id,
          sql: args.sql,
          database: args.database ?? null,
          schema: null,
        });
        return JSON.stringify(result);
      }

      case 'get_last_error': {
        return JSON.stringify({ error: store.error });
      }

      case 'get_query_history': {
        const safeLimit = Math.min(Number(args.limit ?? 10), 50);
        const result = await invoke('get_query_history', {
          connectionId: args.connection_id,
          limit: safeLimit,
        });
        return JSON.stringify(result);
      }

      // -- D: Write-back tools --
      case 'propose_sql_diff': {
        const tabId = String(args.tab_id);
        const sql = store.sqlContent[tabId] ?? '';
        const startOffset = sql.indexOf(String(args.original));
        if (startOffset === -1) {
          return JSON.stringify({ error: 'Original text not found in tab SQL' });
        }
        store.proposeSqlDiff({
          tabId,
          original: String(args.original),
          modified: String(args.modified),
          reason: String(args.reason),
          startOffset,
          endOffset: startOffset + String(args.original).length,
        });
        return JSON.stringify({ status: 'diff proposed, awaiting user confirmation' });
      }

      case 'switch_tab': {
        store.setActiveTab(String(args.tab_id));
        return JSON.stringify({ status: 'switched', tabId: args.tab_id });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
}
