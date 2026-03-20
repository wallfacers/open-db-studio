// src/utils/errorContext.ts
import { useAppStore } from '../store/appStore';
import { useConnectionStore } from '../store/connectionStore';
import { useQueryStore } from '../store/queryStore';
import { useAiStore } from '../store/aiStore';

export interface AppErrorContext {
  userMessage: string;
  markdownContext: string | null;
}

export function buildErrorContext(
  type: 'sql_execute' | 'import' | 'export' | 'ai_request',
  opts: { rawError: string; taskDescription?: string; taskErrorDetails?: string[]; processedRows?: number; totalRows?: number }
): AppErrorContext {
  try {
    const { lastOperationContext } = useAppStore.getState();
    const { connections, metaCache, tables } = useConnectionStore.getState();
    const { queryHistory } = useQueryStore.getState();
    const { configs, sessions, currentSessionId } = useAiStore.getState();
    const activeConfigId = sessions.find((s) => s.id === currentSessionId)?.configId ?? null;

    const connId = lastOperationContext?.connectionId;
    const conn = connId != null ? connections.find((c) => c.id === connId) : undefined;
    const meta = connId != null ? metaCache[connId] : undefined;

    const connLine = conn
      ? `**连接**: ${conn.name} (ID: ${conn.id} · ${conn.driver.toUpperCase()}${meta?.host ? ` · ${meta.host}${meta.port ? `:${meta.port}` : ''}` : ''})`
      : lastOperationContext?.connectionId
      ? `**连接 ID**: ${lastOperationContext.connectionId}`
      : '';

    const versionLine = meta?.dbVersion ? `**版本**: ${meta.dbVersion}` : '';

    const dbLine = lastOperationContext?.database
      ? `**数据库**: \`${lastOperationContext.database}${lastOperationContext.schema ? `.${lastOperationContext.schema}` : ''}\``
      : '';

    if (type === 'sql_execute') {
      const sql = lastOperationContext?.sql ?? '';
      const tableHints = tables.slice(0, 5).map((t: any) => `- \`${t.name}\``).join('\n');
      const historyLines = queryHistory
        .slice(0, 3)
        .map((h: any, i: number) => `${i + 1}. \`${String(h.sql ?? h).slice(0, 80)}\` — ${h.error ? '失败' : '成功'}`)
        .join('\n');

      const parts = [
        '## SQL 执行错误',
        '',
        [connLine, versionLine, dbLine].filter(Boolean).join('\n'),
        '',
        sql ? `**执行的 SQL**:\n\`\`\`sql\n${sql}\n\`\`\`` : '',
        '',
        `**错误信息**: ${opts.rawError}`,
        tableHints ? `\n### 相关表结构（本地缓存）\n${tableHints}` : '',
        historyLines ? `\n### 最近执行历史（最近3条）\n${historyLines}` : '',
      ].filter((s) => s !== undefined);

      return {
        userMessage: `执行失败：${opts.rawError}`,
        markdownContext: parts.join('\n').trim() || null,
      };
    }

    if (type === 'import' || type === 'export') {
      const base = opts.taskDescription ?? '';
      const details = (opts.taskErrorDetails ?? []).slice(0, 10);
      const totalFailed = (opts.taskErrorDetails ?? []).length;
      const progressLine = opts.processedRows != null && opts.totalRows != null
        ? `**进度**: 已处理 ${opts.processedRows.toLocaleString()} / ${opts.totalRows.toLocaleString()} 行`
        : '';
      const detailLines = details.map((d) => `- ${d}`).join('\n');
      const suffix = totalFailed > 10 ? `\n（共 ${totalFailed} 条失败，仅展示前10条）` : '';

      const failSection = [
        '---',
        '### 失败详情',
        progressLine,
        detailLines ? `\n**失败样本（前10条）**:\n${detailLines}${suffix}` : `**错误**: ${opts.rawError}`,
      ].filter(Boolean).join('\n');

      return {
        userMessage: `${type === 'export' ? '导出' : '导入'}失败：${opts.rawError}`,
        markdownContext: base ? `${base}\n\n${failSection}` : failSection,
      };
    }

    if (type === 'ai_request') {
      const config = activeConfigId != null
        ? configs.find((c: any) => c.id === activeConfigId)
        : configs.find((c: any) => c.is_default);
      const reqType = lastOperationContext?.aiRequestType ?? 'chat';
      const reqTypeLabel: Record<string, string> = {
        generate: '生成 SQL', explain: '解释 SQL',
        create_table: 'AI 建表', chat: '对话',
      };

      const parts = [
        '## AI 请求失败',
        '',
        `**请求类型**: ${reqTypeLabel[reqType] ?? reqType}`,
        config ? `**模型配置**: ${config.name} (ID: ${config.id})` : '',
        config?.base_url ? `**API Base URL**: ${config.base_url}` : '',
        lastOperationContext?.httpStatus ? `**HTTP 状态码**: ${lastOperationContext.httpStatus}` : '',
        `**错误信息**: ${opts.rawError}`,
        [connLine, versionLine, dbLine].filter(Boolean).length ? `\n**数据库环境**: ${[conn?.driver?.toUpperCase(), lastOperationContext?.database].filter(Boolean).join(' · ')}${meta?.dbVersion ? ` · ${meta.dbVersion}` : ''}` : '',
        lastOperationContext?.prompt ? `\n**请求内容**:\n\`\`\`\n${lastOperationContext.prompt.slice(0, 500)}\n\`\`\`` : '',
      ].filter(Boolean);

      return {
        userMessage: `AI 请求失败：${opts.rawError}`,
        markdownContext: parts.join('\n').trim() || null,
      };
    }

    return { userMessage: opts.rawError, markdownContext: null };
  } catch {
    return { userMessage: opts.rawError, markdownContext: null };
  }
}
