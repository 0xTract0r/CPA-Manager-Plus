import type { MonitoringEventRow } from './types';

// 客户端请求事件导出（CSV / JSON）：导出「当前已加载/筛选的事件行」，纯前端、不落服务端。
// 列口径参照旧版 apps/web RequestEventsDetailsCard（时间/模型/来源/token/缓存/状态等关键列），
// 并补齐 cpamp 事件行独有的关键列（provider/channel/api_key_hash/ttft/fail_status_code）。

export type EventExportOptions = {
  /** 有模型定价时才输出 cost 列，避免全 0 噪声（与实时表 hasPrices 口径一致）。 */
  hasPrices?: boolean;
};

// CSV 注入防护：单元格若以 = + - @ 开头，前置单引号后再整体加引号（沿用旧版 encodeCsv 口径）。
const encodeCsvCell = (value: string | number | boolean | null | undefined): string => {
  const text = value === null || value === undefined ? '' : String(value);
  const trimmedLeft = text.replace(/^\s+/, '');
  const safeText = trimmedLeft && /^[=+\-@]/.test(trimmedLeft) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
};

const numberOrEmpty = (value: number | null | undefined): number | '' =>
  typeof value === 'number' && Number.isFinite(value) ? value : '';

type EventExportColumn = {
  key: string;
  get: (row: MonitoringEventRow) => string | number;
};

// 导出列定义：CSV 表头与取值共用，保证列顺序稳定、可单测。
export const buildEventExportColumns = (options: EventExportOptions = {}): EventExportColumn[] => {
  const columns: EventExportColumn[] = [
    { key: 'timestamp', get: (row) => row.timestamp },
    { key: 'model', get: (row) => row.model },
    { key: 'resolved_model', get: (row) => row.resolvedModel ?? '' },
    { key: 'source', get: (row) => row.source },
    { key: 'provider', get: (row) => row.provider },
    { key: 'channel', get: (row) => row.channel },
    { key: 'auth_index', get: (row) => row.authIndex },
    { key: 'api_key_hash', get: (row) => row.apiKeyHash },
    { key: 'api_key_label', get: (row) => row.apiKeyLabel },
    { key: 'endpoint', get: (row) => row.endpoint },
    { key: 'result', get: (row) => (row.failed ? 'failed' : 'success') },
    { key: 'fail_status_code', get: (row) => numberOrEmpty(row.failStatusCode) },
    { key: 'cache_hit', get: (row) => (row.cacheReadTokens > 0 ? 'hit' : 'miss') },
    { key: 'latency_ms', get: (row) => numberOrEmpty(row.latencyMs) },
    { key: 'ttft_ms', get: (row) => numberOrEmpty(row.ttftMs) },
    { key: 'input_tokens', get: (row) => row.inputTokens },
    { key: 'output_tokens', get: (row) => row.outputTokens },
    { key: 'reasoning_tokens', get: (row) => row.reasoningTokens },
    { key: 'cache_read_tokens', get: (row) => row.cacheReadTokens },
    { key: 'cache_creation_tokens', get: (row) => row.cacheCreationTokens },
    { key: 'cached_tokens', get: (row) => row.cachedTokens },
    { key: 'total_tokens', get: (row) => row.totalTokens },
  ];

  if (options.hasPrices) {
    columns.push({ key: 'total_cost', get: (row) => row.totalCost });
  }

  return columns;
};

export const buildEventExportCsv = (
  rows: MonitoringEventRow[],
  options: EventExportOptions = {}
): string => {
  const columns = buildEventExportColumns(options);
  const header = columns.map((column) => encodeCsvCell(column.key)).join(',');
  const body = rows.map((row) =>
    columns.map((column) => encodeCsvCell(column.get(row))).join(',')
  );
  return [header, ...body].join('\n');
};

export type EventExportRecord = {
  timestamp: string;
  model: string;
  resolved_model: string;
  source: string;
  provider: string;
  channel: string;
  auth_index: string;
  api_key_hash: string;
  api_key_label: string;
  endpoint: string;
  failed: boolean;
  fail_status_code: number | null;
  cache_hit: boolean;
  latency_ms: number | null;
  ttft_ms: number | null;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cached_tokens: number;
    total_tokens: number;
  };
  total_cost?: number;
};

export const buildEventExportRecords = (
  rows: MonitoringEventRow[],
  options: EventExportOptions = {}
): EventExportRecord[] =>
  rows.map((row) => {
    const record: EventExportRecord = {
      timestamp: row.timestamp,
      model: row.model,
      resolved_model: row.resolvedModel ?? '',
      source: row.source,
      provider: row.provider,
      channel: row.channel,
      auth_index: row.authIndex,
      api_key_hash: row.apiKeyHash,
      api_key_label: row.apiKeyLabel,
      endpoint: row.endpoint,
      failed: row.failed,
      fail_status_code:
        typeof row.failStatusCode === 'number' && Number.isFinite(row.failStatusCode)
          ? row.failStatusCode
          : null,
      cache_hit: row.cacheReadTokens > 0,
      latency_ms:
        typeof row.latencyMs === 'number' && Number.isFinite(row.latencyMs) ? row.latencyMs : null,
      ttft_ms:
        typeof row.ttftMs === 'number' && Number.isFinite(row.ttftMs) ? row.ttftMs : null,
      tokens: {
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        reasoning_tokens: row.reasoningTokens,
        cache_read_tokens: row.cacheReadTokens,
        cache_creation_tokens: row.cacheCreationTokens,
        cached_tokens: row.cachedTokens,
        total_tokens: row.totalTokens,
      },
    };
    if (options.hasPrices) {
      record.total_cost = row.totalCost;
    }
    return record;
  });

export const buildEventExportJson = (
  rows: MonitoringEventRow[],
  options: EventExportOptions = {}
): string => JSON.stringify(buildEventExportRecords(rows, options), null, 2);

export type EventExportFormat = 'csv' | 'json';

// 文件名：usage-events-<ISO 时间，冒号/点替换为连字符>.<csv|json>（沿用旧版命名）。
export const buildEventExportFilename = (
  format: EventExportFormat,
  now: Date = new Date()
): string => `usage-events-${now.toISOString().replace(/[:.]/g, '-')}.${format}`;

export const EVENT_EXPORT_MIME: Record<EventExportFormat, string> = {
  csv: 'text/csv;charset=utf-8',
  json: 'application/json;charset=utf-8',
};
