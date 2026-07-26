import { describe, expect, it } from 'vitest';
import type { MonitoringEventRow } from './types';
import {
  buildEventExportColumns,
  buildEventExportCsv,
  buildEventExportFilename,
  buildEventExportJson,
  buildEventExportRecords,
} from './eventExport';

const baseRow = (overrides: Partial<MonitoringEventRow> = {}): MonitoringEventRow => ({
  id: 'row-1',
  timestamp: '2026-04-25T00:00:00Z',
  timestampMs: Date.UTC(2026, 3, 25, 0, 0, 0),
  dayKey: '2026-04-25',
  hourLabel: '00:00',
  model: 'client-gpt',
  resolvedModel: 'gpt-5.4',
  endpoint: 'POST /v1/chat/completions',
  endpointMethod: 'POST',
  endpointPath: '/v1/chat/completions',
  sourceKey: 'source:user@example.com',
  source: 'user@example.com',
  sourceMasked: 'user@example.com',
  account: 'user@example.com',
  accountMasked: 'user@example.com',
  authIndex: '0',
  authIndexMasked: '0',
  authLabel: '0',
  projectId: '',
  apiKeyHash: '1234567890abcdef',
  apiKeyLabel: 'Team A',
  apiKeyMasked: 'sk-...cdef',
  provider: 'openai',
  planType: '-',
  channel: 'openai',
  channelHost: '-',
  channelDisabled: false,
  failed: false,
  statsIncluded: true,
  latencyMs: 1500,
  ttftMs: 500,
  tokensPerSecond: 20,
  inputTokens: 10,
  outputTokens: 20,
  reasoningTokens: 3,
  cachedTokens: 5,
  cacheReadTokens: 4,
  cacheCreationTokens: 1,
  totalTokens: 33,
  totalCost: 0.0123,
  taskKey: 'task-1',
  searchText: '',
  ...overrides,
});

describe('eventExport', () => {
  it('builds a CSV with a stable header and one row per event', () => {
    const csv = buildEventExportCsv([baseRow()]);
    const lines = csv.split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"timestamp"');
    expect(lines[0]).toContain('"model"');
    expect(lines[0]).toContain('"source"');
    expect(lines[0]).toContain('"result"');
    expect(lines[0]).toContain('"cache_hit"');
    expect(lines[0]).toContain('"total_tokens"');
    // hasPrices 未开启时不输出 cost 列。
    expect(lines[0]).not.toContain('"total_cost"');

    expect(lines[1]).toContain('"2026-04-25T00:00:00Z"');
    expect(lines[1]).toContain('"client-gpt"');
    expect(lines[1]).toContain('"user@example.com"');
    expect(lines[1]).toContain('"success"');
    expect(lines[1]).toContain('"hit"');
    expect(lines[1]).toContain('"33"');
  });

  it('marks failed rows and cache misses in CSV', () => {
    const csv = buildEventExportCsv([
      baseRow({ failed: true, failStatusCode: 429, cacheReadTokens: 0 }),
    ]);
    const row = csv.split('\n')[1];

    expect(row).toContain('"failed"');
    expect(row).toContain('"429"');
    expect(row).toContain('"miss"');
  });

  it('appends the cost column only when hasPrices is true', () => {
    const csv = buildEventExportCsv([baseRow()], { hasPrices: true });
    const [header, row] = csv.split('\n');

    expect(header).toContain('"total_cost"');
    expect(row).toContain('"0.0123"');
    expect(buildEventExportColumns({ hasPrices: true })).toHaveLength(
      buildEventExportColumns().length + 1
    );
  });

  it('guards CSV formula injection by prefixing a leading quote', () => {
    const csv = buildEventExportCsv([baseRow({ model: '=SUM(A1:A2)' })]);
    const row = csv.split('\n')[1];

    // 以 = 开头的单元格被前置单引号，避免电子表格把它当公式执行。
    expect(row).toContain(`"'=SUM(A1:A2)"`);
  });

  it('escapes embedded double quotes in CSV cells', () => {
    const csv = buildEventExportCsv([baseRow({ source: 'label "quoted" value' })]);
    const row = csv.split('\n')[1];

    expect(row).toContain('"label ""quoted"" value"');
  });

  it('builds JSON records with nested tokens and normalized nulls', () => {
    const json = buildEventExportJson([
      baseRow({ failed: true, failStatusCode: 500, latencyMs: null, ttftMs: null }),
    ]);
    const parsed = JSON.parse(json) as ReturnType<typeof buildEventExportRecords>;

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      timestamp: '2026-04-25T00:00:00Z',
      model: 'client-gpt',
      source: 'user@example.com',
      provider: 'openai',
      channel: 'openai',
      auth_index: '0',
      api_key_hash: '1234567890abcdef',
      failed: true,
      fail_status_code: 500,
      cache_hit: true,
      latency_ms: null,
      ttft_ms: null,
    });
    expect(parsed[0].tokens).toMatchObject({
      input_tokens: 10,
      output_tokens: 20,
      reasoning_tokens: 3,
      cache_read_tokens: 4,
      cache_creation_tokens: 1,
      cached_tokens: 5,
      total_tokens: 33,
    });
    // hasPrices 未开启时 JSON 不含 total_cost。
    expect(parsed[0]).not.toHaveProperty('total_cost');
  });

  it('includes total_cost in JSON when hasPrices is true', () => {
    const json = buildEventExportJson([baseRow()], { hasPrices: true });
    const parsed = JSON.parse(json) as ReturnType<typeof buildEventExportRecords>;

    expect(parsed[0].total_cost).toBe(0.0123);
  });

  it('formats the export filename with a filesystem-safe timestamp', () => {
    const fixed = new Date('2026-04-25T01:02:03.456Z');

    expect(buildEventExportFilename('csv', fixed)).toBe('usage-events-2026-04-25T01-02-03-456Z.csv');
    expect(buildEventExportFilename('json', fixed)).toBe(
      'usage-events-2026-04-25T01-02-03-456Z.json'
    );
  });

  it('produces an empty body (header only) for no rows', () => {
    expect(buildEventExportCsv([])).toBe(buildEventExportColumns().map((c) => `"${c.key}"`).join(','));
    expect(buildEventExportJson([])).toBe('[]');
  });
});
