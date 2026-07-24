/**
 * 日志相关 API
 */

import { apiClient } from './client';
import { LOGS_TIMEOUT_MS } from '@/utils/constants';

export interface LogsQuery {
  after?: number;
  cursor?: string;
  limit?: number;
}

export interface LogsResponse {
  lines: string[];
  'line-count': number;
  'latest-timestamp': number;
  latestAfter?: number;
  nextCursor?: string;
  cursorReset?: boolean;
}

export interface ErrorLogFile {
  name: string;
  size?: number;
  modified?: number;
}

export interface ErrorLogsResponse {
  files?: ErrorLogFile[];
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const numberValue = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const stringValue = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const booleanValue = (value: unknown): boolean =>
  value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');

export const normalizeLogsResponse = (value: unknown): LogsResponse => {
  const source = asRecord(value);
  const lines = Array.isArray(source.lines)
    ? source.lines.map((line) => String(line ?? ''))
    : [];
  const lineCount = numberValue(source['line-count'] ?? source.lineCount) ?? lines.length;
  const latestTimestamp = numberValue(source['latest-timestamp'] ?? source.latestTimestamp) ?? 0;
  const rawLatestAfter =
    numberValue(source.latestAfter ?? source.latest_after ?? source['latest-after']) ??
    latestTimestamp;
  const latestAfter = rawLatestAfter > 0 ? rawLatestAfter : undefined;
  const nextCursor = stringValue(source['next-cursor'] ?? source.nextCursor ?? source.next_cursor);

  return {
    lines,
    'line-count': lineCount,
    'latest-timestamp': latestTimestamp,
    latestAfter,
    nextCursor,
    cursorReset: booleanValue(source['cursor-reset'] ?? source.cursorReset ?? source.cursor_reset),
  };
};

// 溯源取数端点路径集中在此，下载(blob)与页内查看(text)复用同一构造，避免端点字面量重复。
const requestLogByIdPath = (id: string) => `/request-log-by-id/${encodeURIComponent(id)}`;

export const logsApi = {
  async fetchLogs(params: LogsQuery = {}): Promise<LogsResponse> {
    const data = await apiClient.get('/logs', { params, timeout: LOGS_TIMEOUT_MS });
    return normalizeLogsResponse(data);
  },

  clearLogs: () => apiClient.delete('/logs'),

  fetchErrorLogs: (): Promise<ErrorLogsResponse> =>
    apiClient.get('/request-error-logs', { timeout: LOGS_TIMEOUT_MS }),

  downloadErrorLog: (filename: string) =>
    apiClient.getRaw(`/request-error-logs/${encodeURIComponent(filename)}`, {
      responseType: 'blob',
      timeout: LOGS_TIMEOUT_MS
    }),

  downloadRequestLogById: (id: string) =>
    apiClient.getRaw(requestLogByIdPath(id), {
      responseType: 'blob',
      timeout: LOGS_TIMEOUT_MS
    }),

  // 页内查看器取数：命中同一 /request-log-by-id/{id} 端点，但以文本形式返回，
  // 供 RequestLogViewer 直接在网页端渲染 + 检索原文，避免再实现一条取数路径。
  async getRequestLogTextById(id: string): Promise<string> {
    const response = await apiClient.getRaw(requestLogByIdPath(id), {
      responseType: 'text',
      timeout: LOGS_TIMEOUT_MS
    });
    const { data } = response;
    if (typeof data === 'string') return data;
    if (data instanceof Blob) return data.text();
    return data === null || data === undefined ? '' : String(data);
  },
};
