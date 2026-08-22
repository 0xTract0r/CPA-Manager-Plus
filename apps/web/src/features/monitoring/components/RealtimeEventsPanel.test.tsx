import { renderToStaticMarkup } from 'react-dom/server';
import type { TFunction } from 'i18next';
import { describe, expect, it, vi } from 'vitest';
import type { AccountDisplayMode } from '@/features/monitoring/accountOverviewState';
import type { MonitoringEventRow } from '@/features/monitoring/hooks/useMonitoringData';
import { formatInUtc8 } from '@/utils/datetime';
import styles from '../MonitoringCenterPage.module.scss';
import { RealtimeEventsPanel, RealtimeEventsPanelActions } from './RealtimeEventsPanel';

const t = ((key: string, options?: Record<string, unknown>) => {
  const messages: Record<string, string> = {
    'common.loading': 'Loading',
    'common.copy': 'Copy',
    'monitoring.account_overview_account_display_masked': 'Masked',
    'monitoring.account_overview_account_display_full': 'Full',
    'monitoring.account_overview_show_full_accounts_hint': 'Show full accounts',
    'monitoring.account_overview_show_masked_accounts_hint': 'Show masked accounts',
    'monitoring.cached_tokens_short': 'Cached',
    'monitoring.cache_creation_tokens_short': 'Create',
    'monitoring.cache_read_tokens_short': 'Read',
    'monitoring.column_cache_hit_rate': 'Cache Hit Rate',
    'monitoring.column_cache_hit_rate_short': 'Cache Hit',
    'monitoring.column_latency': 'Latency',
    'monitoring.column_model': 'Model',
    'monitoring.column_output_tps': 'TPS',
    'monitoring.column_source_api_key': 'Source / API Key',
    'monitoring.column_success_rate': 'Success',
    'monitoring.column_time': 'Time',
    'monitoring.column_type': 'Type',
    'monitoring.filter_low_cache_hit_rate': 'Low Cache Hit Only',
    'monitoring.filter_low_cache_hit_rate_short': 'Low Cache Hit',
    'monitoring.filter_low_cache_hit_rate_hint':
      'Show only rows with a cache hit rate below {{threshold}}.',
    'monitoring.filter_low_cache_hit_rate_threshold_menu_label': 'Change low cache hit threshold',
    'monitoring.filter_low_cache_hit_rate_threshold_custom': 'Custom threshold',
    'monitoring.filter_low_cache_hit_rate_threshold_custom_invalid':
      'Enter a number between 0 and 100.',
    'monitoring.filter_low_cache_hit_rate_scope_hint':
      'Filters all data in the current time window by cache hit rate (server-side).',
    'common.confirm': 'Confirm',
    'monitoring.elapsed_short': 'Elapsed',
    'monitoring.executor_type_short': 'Executor',
    'monitoring.fail_status_code_short': 'HTTP',
    'monitoring.filter_account': 'Account',
    'monitoring.filter_status_failed': 'Failed only',
    'monitoring.filter_provider': 'Provider',
    'monitoring.load_more_events': 'Load more',
    'monitoring.log_rows': 'Rows',
    'monitoring.no_more_events': 'No more events',
    'monitoring.events_loaded_summary': 'Loaded {{loaded}} of {{total}} events',
    'monitoring.events_all_loaded': 'All {{total}} events loaded',
    'monitoring.events_retention_limited': 'Kept the newest {{loaded}} of {{total}} events',
    'monitoring.reasoning_effort': 'Effort',
    'monitoring.reasoning_effort_short': 'Effort',
    'monitoring.reasoning_tier_hint':
      'Line 1 is the reasoning effort; line 2, in dimmed small text, is the requested service tier.',
    'monitoring.recent_failures': 'Failures',
    'monitoring.recent_status': 'Recent',
    'monitoring.realtime_api_key_hash': 'API Key hash',
    'monitoring.realtime_api_key_label': 'API Key',
    'monitoring.realtime_api_key_masked': 'Masked key',
    'monitoring.realtime_cache_hit_rate_hint':
      '(cachedTokens + cacheReadTokens) / (max(inputTokens, cachedTokens) + cacheReadTokens + cacheCreationTokens) for this single request. Shows “--” when there is no input-side token data.',
    'monitoring.realtime_request_log_action': 'View raw request',
    'monitoring.realtime_request_log_action_hint':
      'Fetch the raw request/response body for request_id {{id}}.',
    'monitoring.realtime_request_log_untraceable': 'Not traceable',
    'monitoring.realtime_request_log_untraceable_hint':
      'This row has no request_id, so the raw request log cannot be retrieved.',
    'monitoring.realtime_success_rate_hint':
      'Rolling success rate for this account + provider + model + channel combination, not the result of this single request.',
    'monitoring.realtime_usage_hint':
      'I = input tokens, O = output tokens, R = reasoning tokens; also shows cache read/write tokens when present.',
    'monitoring.request_status': 'Status',
    'monitoring.result_failed': 'Failed',
    'monitoring.result_success': 'Success',
    'monitoring.service_tier_short': 'Tier',
    'monitoring.this_call_cost': 'Cost',
    'monitoring.this_call_usage': 'Usage',
    'monitoring.ttft_short': 'TTFT',
    'usage_stats.export_csv': 'Export CSV',
    'usage_stats.export_json': 'Export JSON',
  };
  let message = messages[key] ?? key;
  if (options) {
    message = message.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
      String((options as Record<string, unknown>)[name] ?? '')
    );
  }
  return message;
}) as unknown as TFunction;

const noop = vi.fn();

type PanelRow = MonitoringEventRow & {
  requestCount: number;
  successRate: number;
  streamKey: string;
  recentPattern: boolean[];
};

type PanelOverrides = {
  accountDisplayMode?: AccountDisplayMode;
  eventsHasMore?: boolean;
  eventsLoadingMore?: boolean;
  eventsRetentionLimited?: boolean;
  eventsTotalCount?: number;
  eventsLoadedCount?: number;
  lowCacheHitRateOnly?: boolean;
  lowCacheHitRateThreshold?: number;
};

const baseRow = (overrides: Partial<PanelRow> = {}): PanelRow => ({
  id: 'row-1',
  timestamp: '2026-04-25T00:00:00Z',
  timestampMs: Date.UTC(2026, 3, 25, 12, 34, 56),
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
  apiKeyHash: '',
  apiKeyLabel: '-',
  apiKeyMasked: '-',
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
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 33,
  totalCost: 0,
  taskKey: 'task-1',
  searchText: '',
  requestCount: 1,
  successRate: 1,
  streamKey: 'stream-1',
  recentPattern: [true],
  ...overrides,
});

const renderPanel = (row: PanelRow, overrides: PanelOverrides = {}) =>
  renderToStaticMarkup(
    <RealtimeEventsPanel
      embedded
      rows={[row]}
      pagination={{
        currentPage: 1,
        totalPages: 1,
        pageItems: [row],
        startItem: 1,
        endItem: 1,
      }}
      pageSize={10}
      scopedFailureCount={row.failed ? 1 : 0}
      failedOnlyActive={false}
      lowCacheHitRateOnly={overrides.lowCacheHitRateOnly ?? false}
      lowCacheHitRateThreshold={overrides.lowCacheHitRateThreshold ?? 0.3}
      eventsHasMore={overrides.eventsHasMore ?? false}
      eventsLoadingMore={overrides.eventsLoadingMore ?? false}
      eventsRetentionLimited={overrides.eventsRetentionLimited ?? false}
      eventsTotalCount={overrides.eventsTotalCount ?? 1}
      eventsLoadedCount={overrides.eventsLoadedCount ?? 1}
      overallLoading={false}
      hasPrices={false}
      accountDisplayMode={overrides.accountDisplayMode ?? 'masked'}
      locale="en-US"
      emptyState={<span>empty</span>}
      t={t}
      onToggleFailedOnly={noop}
      onToggleLowCacheHitRateOnly={noop}
      onLowCacheHitRateThresholdChange={noop}
      onAccountDisplayModeChange={noop}
      onPageChange={noop}
      onPageSizeChange={noop}
      onLoadMoreEvents={noop}
    />
  );

const renderActions = (overrides: { exportRows?: PanelRow[]; hasPrices?: boolean } = {}) =>
  renderToStaticMarkup(
    <RealtimeEventsPanelActions
      rowCount={1}
      scopedFailureCount={0}
      failedOnlyActive={false}
      lowCacheHitRateOnly={false}
      lowCacheHitRateThreshold={0.3}
      accountDisplayMode="masked"
      exportRows={overrides.exportRows ?? [baseRow()]}
      hasPrices={overrides.hasPrices ?? false}
      t={t}
      onToggleFailedOnly={noop}
      onToggleLowCacheHitRateOnly={noop}
      onLowCacheHitRateThresholdChange={noop}
      onAccountDisplayModeChange={noop}
    />
  );

describe('RealtimeEventsPanel', () => {
  // 组件已迁到全局时区 + 标准格式渲染（date=YYYY-MM-DD via dateStyle:'medium'，
  // time=HH:mm:ss via timeStyle:'medium'）；预期值走与组件同款的 formatInUtc8 选项，
  // 标准数字格式与 locale/机器本地时区无关，避免断言写死某地区格式。
  const expectedDate = formatInUtc8(baseRow().timestampMs, { dateStyle: 'medium' }, 'en-US');
  const expectedTime = formatInUtc8(baseRow().timestampMs, { timeStyle: 'medium' }, 'en-US');

  it('renders CPA v7.1.18 usage details for failed rows', () => {
    const markup = renderPanel(
      baseRow({
        failed: true,
        successRate: 0,
        executorType: 'codex',
        reasoningEffort: 'medium',
        serviceTier: 'priority',
        cacheReadTokens: 4,
        cacheCreationTokens: 1,
        failStatusCode: 429,
        failSummary: 'rate limit exceeded',
      })
    );

    // 强度/等级合并为单列两行：只有一个合并表头(复用 Effort 短名 + tableHeaderWithInfo
    // 信息图标)，不再有独立的 Tier 表头列。
    expect(markup).toMatch(/<th><span class="[^"]*tableHeaderWithInfo[^"]*"><span>Effort<\/span>/);
    expect(markup).not.toMatch(/<th><span class="[^"]*tableHeaderWithInfo[^"]*"><span>Tier<\/span>/);
    expect(markup).toContain('>TPS</th>');
    expect(markup).toContain('Source / API Key');
    expect(markup).not.toContain('>Executor: codex<');
    expect(markup).not.toContain('Executor: codex');
    // 单列两行(仿"用量"列)：第 1 行 effort 主值(无前缀)，第 2 行 service_tier 灰色小字
    // (无 tier= 前缀、无 tone class，靠列头信息图标说明语义)。
    expect(markup).toContain('medium');
    expect(markup).not.toContain('Effort: medium');
    expect(markup).not.toContain('tier=priority');
    expect(markup).not.toContain('Tier: priority');
    // 第 2 行是纯 service_tier 值的灰色弱化小字(primaryCell 默认 <small>)，不带 tone/前缀。
    expect(markup).toMatch(/<small>priority<\/small>/);
    // effort 主值走 realtimeReasoningValue span，与 tier 小字同在 primaryCell 里。
    expect(markup).toMatch(/<span class="[^"]*realtimeReasoningValue[^"]*">medium<\/span>/);
    expect(markup).toContain('client-gpt');
    expect(markup).toContain('gpt-5.4');
    expect(markup).not.toContain('Resolved');
    expect(markup).not.toContain('POST /v1/chat/completions');
    expect(markup).toContain('Failed');
    expect(markup).toMatch(/TTFT<\/span><span class="[^"]+">｜<\/span><span class="[^"]+">Elapsed/);
    expect(markup).toContain('500 ms');
    expect(markup).toContain('Elapsed');
    expect(markup).toContain('1.5 s');
    expect(markup).toContain('20');
    // 用量各段各自渲染为独立 span（防止窄列数字断行），" · " 分隔符落在段内，
    // 因此不再断言整段连续字符串，改为逐段校验并核对 DOM 顺序。
    expect(markup).toContain('I 10 · ');
    expect(markup).toContain('O 20 · ');
    expect(markup).toContain('R 3 · ');
    expect(markup).toContain('Create 1 · ');
    expect(markup).toContain('Read 4');
    const usageOrder = ['I 10', 'O 20', 'R 3', 'Create 1', 'Read 4'].map((needle) =>
      markup.indexOf(needle)
    );
    expect(usageOrder).toEqual([...usageOrder].sort((a, b) => a - b));
    expect(markup).toContain('role="tooltip"');
    expect(markup).toContain(styles.realtimeFailureTooltip);
    expect(markup).toContain(styles.realtimeFailureTooltipBelow);
    expect(markup).toContain('aria-describedby=');
    expect(markup).toContain('aria-label="HTTP 429 · rate limit exceeded"');
    expect(markup).toContain('aria-label="Copy"');
    expect(markup).toContain('HTTP 429');
    expect(markup).toContain('rate limit exceeded');
  });

  it('renders a "view raw request" trigger in the source cell when the row carries a request_id', () => {
    const markup = renderPanel(baseRow({ requestId: 'req-trace-42' }));

    expect(markup).toContain('View raw request');
    expect(markup).toContain(styles.realtimeRequestLogTrigger);
    expect(markup).toContain('title="Fetch the raw request/response body for request_id req-trace-42."');
    // 有 request_id 时不应显示「不可溯源」占位。
    expect(markup).not.toContain('Not traceable');
    // 触发按钮嵌在 source 单元格里，不新增列(强度/等级合并为单列后共 13 列)。
    expect(markup.match(/<col\b/g)).toHaveLength(13);
  });

  it('marks the row as not traceable (not blank) when the request_id is missing', () => {
    const markup = renderPanel(baseRow({ requestId: undefined }));

    expect(markup).toContain('Not traceable');
    expect(markup).toContain(styles.realtimeRequestLogUntraceable);
    expect(markup).not.toContain('View raw request');
    expect(markup.match(/<col\b/g)).toHaveLength(13);
  });

  it('renders safe defaults when optional usage fields are missing', () => {
    const markup = renderPanel(baseRow({ reasoningTokens: 0 }));

    expect(markup).toContain('<colgroup>');
    expect(markup.match(/<col\b/g)).toHaveLength(13);
    expect(markup).not.toContain('Effort -');
    expect(markup).toMatch(/<th><span class="[^"]*tableHeaderWithInfo[^"]*"><span>Effort<\/span>/);
    expect(markup).toContain('>TPS</th>');
    expect(markup).toContain('Success');
    expect(markup).toMatch(/TTFT<\/span><span class="[^"]+">｜<\/span><span class="[^"]+">Elapsed/);
    expect(markup).toContain(expectedDate);
    expect(markup).toContain(expectedTime);
    // 细分缓存字段(cacheReadTokens/cacheCreationTokens)全为 0 但 legacy cachedTokens=5 时，
    // 用 "Cached 5" 兜底展示，不再输出语义空洞的裸 "C 5"。用量各段渲染为独立 span，
    // 因此逐段校验而非断言整段连续字符串。
    expect(markup).toContain('I 10 · ');
    expect(markup).toContain('O 20');
    expect(markup).toContain('Cached 5');
    const usageOrder = ['I 10', 'O 20', 'Cached 5'].map((needle) => markup.indexOf(needle));
    expect(usageOrder).toEqual([...usageOrder].sort((a, b) => a - b));
    expect(markup).not.toContain('R 0');
    expect(markup).not.toContain('Read 0');
    expect(markup).not.toContain('Create 0');
    // 成功行不渲染失败诊断浮层。失败浮层用 .realtimeFailureTooltip，与模型名即时浮层的
    // .realtimeModelTooltip 是两套机制；模型浮层带 role="tooltip" / aria-describedby 属正常，
    // 因此这里只针对失败态诊断做负向断言，不再笼统否定 role="tooltip" / aria-describedby。
    expect(markup).not.toContain(styles.realtimeFailureTooltip);
    expect(markup).not.toContain('HTTP');
  });

  it('renders API key alias inside the source cell without adding another column', () => {
    const markup = renderPanel(
      baseRow({
        apiKeyHash: '1234567890abcdef',
        apiKeyLabel: 'Team A',
        apiKeyMasked: 'sk-...cdef',
        executorType: 'codex',
      })
    );

    expect(markup).toContain('<th>Source / API Key</th>');
    expect(markup).toContain('API Key: Team A');
    expect(markup).not.toContain('#12345678');
    expect(markup).toContain('API Key hash: 1234567890abcdef');
    expect(markup).toContain('Masked key: sk-...cdef');
    expect(markup).toContain('Executor: codex');
    expect(markup).not.toContain('>Executor: codex<');
  });

  it('keeps long realtime model names constrained and exposes the full name via an instant tooltip', () => {
    const longModel =
      'claude-opus-4-6-thinking-with-a-very-long-provider-routing-suffix-for-realtime-monitoring';
    const markup = renderPanel(baseRow({ model: longModel, resolvedModel: longModel }));

    // 长模型名仍被 .realtimeModelCell / .realtimeModelText 的窄列 nowrap 省略号约束展示。
    expect(markup).toMatch(/class="[^"]*realtimeModelCell[^"]*"/);
    expect(markup).toMatch(/class="[^"]*realtimeModelText[^"]*"/);
    // 全名不再依赖浏览器原生 title（~1s 延迟），改为即时浮层：role="tooltip" 独立元素，
    // trigger 通过 aria-describedby 指向同一 tooltip id。
    expect(markup).not.toContain(`title="${longModel}"`);

    // .realtimeModelTooltip 视觉样式现在也被表头 TableHeaderInfo 浮层复用(见下方
    // "renders the cache hit rate column with header tooltips..." 用例)，因此不能再假定
    // 该 class 在整页只出现一次；改为直接按 id 命名规则(`-model-tooltip-`)定位模型浮层。
    const tooltipMatch = markup.match(
      /<span id="([^"]*-model-tooltip-[^"]*)" role="tooltip"[^>]*realtimeModelTooltip[^>]*>/
    );
    expect(tooltipMatch).not.toBeNull();
    const tooltipId = tooltipMatch?.[1] ?? '';
    expect(tooltipId).toContain('model-tooltip');
    expect(markup).toContain(`aria-describedby="${tooltipId}"`);
    // 浮层主槽内含完整模型全名文案。
    expect(markup).toMatch(new RegExp(`realtimeModelTooltipPrimary[^>]*>${longModel}</span>`));
  });

  it('switches realtime source labels between masked and full display', () => {
    const row = baseRow({
      source: 'very-long-user@example.com',
      sourceMasked: 'ver***@example.com',
      account: 'very-long-user@example.com',
      accountMasked: 'ver***@example.com',
      authLabel: '',
      channel: 'openai',
      channelHost: '-',
      provider: 'openai',
    });
    const maskedMarkup = renderPanel(row);
    const fullMarkup = renderPanel(row, { accountDisplayMode: 'full' });

    expect(maskedMarkup).toContain('>ver***@example.com</span>');
    expect(maskedMarkup).toContain(
      'title="ver***@example.com · Provider: openai · very-long-user@example.com'
    );
    expect(fullMarkup).toContain('>very-long-user@example.com</span>');
    expect(fullMarkup).toContain('title="very-long-user@example.com · Provider: openai');
  });

  it('switches the primary source text instead of adding an account metadata line', () => {
    const row = baseRow({
      source: 'visible-user@example.com',
      sourceMasked: 'vis***@example.com',
      account: 'visible-user@example.com',
      accountMasked: 'vis***@example.com',
      authLabel: '',
      channel: 'openai',
      channelHost: '-',
      provider: 'openai',
    });
    const maskedMarkup = renderPanel(row);
    const fullMarkup = renderPanel(row, { accountDisplayMode: 'full' });

    expect(maskedMarkup).toContain('>vis***@example.com</span>');
    expect(maskedMarkup).not.toContain('<small>Account: vis***@example.com</small>');
    expect(fullMarkup).toContain('>visible-user@example.com</span>');
    expect(fullMarkup).not.toContain('<small>Account: visible-user@example.com</small>');
  });

  it('renders a ttft placeholder when ttft is missing', () => {
    const markup = renderPanel(baseRow({ ttftMs: null }));

    expect(markup).toContain('>TPS</th>');
    expect(markup).toMatch(/TTFT<\/span><span class="[^"]+">｜<\/span><span class="[^"]+">Elapsed/);
    expect(markup).not.toContain('500 ms');
    expect(markup).toContain('1.5 s');
    expect(markup).toMatch(
      /--<\/span><span class="[^"]+">｜<\/span><span class="[^"]*realtimeMetricText[^"]*realtimeMetricRight[^"]*">1\.5 s<\/span>/
    );
  });

  it('keeps latency warning and error tone classes on plain text metrics', () => {
    const warningMarkup = renderPanel(baseRow({ latencyMs: 20_000, ttftMs: 1_000 }));
    const errorMarkup = renderPanel(baseRow({ latencyMs: 35_000, ttftMs: 1_000 }));

    expect(warningMarkup).toMatch(/class="[^"]*realtimeMetricText[^"]*warnText[^"]*"/);
    expect(errorMarkup).toMatch(/class="[^"]*realtimeMetricText[^"]*badText[^"]*"/);
  });

  it('colors normal millisecond and second metrics green for both ttft and elapsed time', () => {
    const markup = renderPanel(baseRow({ latencyMs: 470, ttftMs: 120 }));

    expect(markup).toMatch(
      /class="[^"]*realtimeMetricText[^"]*realtimeMetricLeft[^"]*goodText[^"]*">120 ms/
    );
    expect(markup).toMatch(
      /class="[^"]*realtimeMetricText[^"]*realtimeMetricRight[^"]*goodText[^"]*">470 ms/
    );
  });

  it('omits the semantically empty legacy "C" token once cache read/creation are broken out', () => {
    const markup = renderPanel(
      baseRow({
        cachedTokens: 4,
        cacheReadTokens: 4,
        cacheCreationTokens: 1,
      })
    );

    expect(markup).not.toContain('C 4');
    expect(markup).not.toContain('Cached 4');
    expect(markup).toContain('Read 4');
    expect(markup).toContain('Create 1');
  });

  it('shows the loaded vs total summary with a load-more action when more pages exist', () => {
    const markup = renderPanel(baseRow(), {
      eventsHasMore: true,
      eventsLoadedCount: 500,
      eventsTotalCount: 8000,
    });

    expect(markup).toContain('Loaded 500 of 8000 events');
    expect(markup).toContain('Load more');
    expect(markup).not.toContain('Loaded 8000 of 8000');
  });

  it('shows the all-loaded summary without a load-more action once fully loaded', () => {
    const markup = renderPanel(baseRow(), {
      eventsHasMore: false,
      eventsLoadedCount: 8000,
      eventsTotalCount: 8000,
    });

    expect(markup).toContain('All 8000 events loaded');
    expect(markup).not.toContain('Load more');
  });

  it('shows the retention limit without a load-more action at the memory cap', () => {
    const markup = renderPanel(baseRow(), {
      eventsHasMore: false,
      eventsRetentionLimited: true,
      eventsLoadedCount: 2000,
      eventsTotalCount: 8000,
    });

    expect(markup).toContain('Kept the newest 2000 of 8000 events');
    expect(markup).not.toContain('Load more');
  });

  it('falls back to the loaded count when the backend omits a larger total', () => {
    const markup = renderPanel(baseRow(), {
      eventsHasMore: true,
      eventsLoadedCount: 500,
      eventsTotalCount: 500,
    });

    expect(markup).toContain('Loaded 500 of 500 events');
    expect(markup).toContain('Load more');
  });

  it('renders the cache hit rate column with header tooltips right after the usage column', () => {
    const markup = renderPanel(
      baseRow({
        inputTokens: 10,
        cachedTokens: 5,
        cacheReadTokens: 3,
        cacheCreationTokens: 2,
      })
    );

    // 新口径（非 Anthropic model）：分子取 cacheReadTokens 优先；
    // 分母 = max(inputTokens, cacheReadTokens) + cacheCreationTokens = max(10, 3) + 2 = 12；
    // 3 / 12 = 25.0%
    expect(markup).toContain('Cache Hit');
    expect(markup).toContain('25.0%');
    // 表头信息浮层改用 TableHeaderInfo 即时浮层(见 RealtimeModelCell 同款 portal 手法)，
    // 不再依赖浏览器原生 title=(约 0.5-1s 不可控延迟、触屏点击不触发)；信息图标的可访问名
    // 落在可聚焦 trigger 的 aria-label 上。
    expect(markup).not.toContain(
      'title="Rolling success rate for this account + provider + model + channel combination, not the result of this single request."'
    );
    expect(markup).toContain(
      'aria-label="Rolling success rate for this account + provider + model + channel combination, not the result of this single request."'
    );
    expect(markup).toContain(
      'aria-label="I = input tokens, O = output tokens, R = reasoning tokens; also shows cache read/write tokens when present."'
    );
    expect(markup).toContain(
      'aria-label="(cachedTokens + cacheReadTokens) / (max(inputTokens, cachedTokens) + cacheReadTokens + cacheCreationTokens) for this single request. Shows “--” when there is no input-side token data."'
    );
    // 强度/等级合并为单列后只有一个合并表头挂信息图标，浮层说明两行(reasoning effort +
    // service tier 灰色小字)；不再有独立的 Service tier 表头浮层。
    expect(markup).toContain('aria-label="Line 1 is the reasoning effort; line 2, in dimmed small text, is the requested service tier.');
    expect(markup).not.toContain('aria-label="Service tier requested by the client for this call."');
    // 信息图标的即时浮层 trigger 存在(可聚焦、承担 aria-describedby)：Effort(合并) / Success /
    // Usage / Cache Hit 共 4 个。
    expect(markup.match(new RegExp(styles.tableHeaderInfoTrigger, 'g'))?.length).toBe(4);
    // 列顺序：本次用量(Usage) -> 缓存命中率(Cache Hit) -> 花费(Cost)。
    const usageIdx = markup.indexOf('Usage');
    const cacheHitHeaderIdx = markup.indexOf('Cache Hit');
    const costIdx = markup.indexOf('>Cost<');
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(cacheHitHeaderIdx).toBeGreaterThan(usageIdx);
    expect(costIdx).toBeGreaterThan(cacheHitHeaderIdx);
  });

  it('renders both filter chips side by side in the masthead actions toolbar', () => {
    const markup = renderActions();

    // "仅显示失败" 与 "仅显示低命中率" chip 在同一行工具条内并排渲染。
    const failedIdx = markup.indexOf('Failed only');
    const lowCacheIdx = markup.indexOf('Low Cache Hit');
    expect(failedIdx).toBeGreaterThanOrEqual(0);
    expect(lowCacheIdx).toBeGreaterThan(failedIdx);
  });

  it('renders enabled CSV/JSON export buttons in the actions toolbar when rows are loaded', () => {
    const markup = renderActions();

    expect(markup).toContain('Export CSV');
    expect(markup).toContain('Export JSON');
    // 有数据时导出按钮不应被禁用。
    expect(markup).not.toContain('disabled=""');
  });

  it('disables the export buttons when there are no loaded event rows', () => {
    const markup = renderActions({ exportRows: [] });

    expect(markup).toContain('Export CSV');
    expect(markup).toContain('Export JSON');
    expect(markup).toContain('disabled=""');
  });

  it('filters displayed rows to low cache hit rate when the chip is active', () => {
    const highHitRow = baseRow({
      id: 'high',
      inputTokens: 10,
      cachedTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });

    const activeMarkup = renderPanel(highHitRow, { lowCacheHitRateOnly: true });
    const inactiveMarkup = renderPanel(highHitRow, { lowCacheHitRateOnly: false });

    // 100% 命中率的行在开启低命中率过滤后应被隐藏（fallback 到空态），关闭时正常展示。
    expect(inactiveMarkup).toContain('100.0%');
    expect(activeMarkup).not.toContain('100.0%');
    expect(activeMarkup).toContain('empty');
  });

  it('shows the current threshold on the chip label and lets a lower threshold pass through more rows', () => {
    const markup = renderActions();
    // chip 文案带当前阈值(如 "Low Cache Hit <30%")，用户无需猜测筛选口径。
    expect(markup).toContain('Low Cache Hit &lt;30%');
  });

  it('filters displayed rows using the configured threshold, not a hardcoded 30%', () => {
    // 命中率 40%：在默认阈值(<30%)下不算低命中率，但把阈值配置成 <50% 后应被筛出。
    const midHitRow = baseRow({
      id: 'mid',
      inputTokens: 10,
      cachedTokens: 4,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });

    const defaultThresholdMarkup = renderPanel(midHitRow, {
      lowCacheHitRateOnly: true,
      lowCacheHitRateThreshold: 0.3,
    });
    const widerThresholdMarkup = renderPanel(midHitRow, {
      lowCacheHitRateOnly: true,
      lowCacheHitRateThreshold: 0.5,
    });

    expect(defaultThresholdMarkup).toContain('empty');
    expect(widerThresholdMarkup).not.toContain('empty');
    expect(widerThresholdMarkup).toContain('40.0%');
  });

  it('shows "--" for cache hit rate when there is no input-side token data', () => {
    const markup = renderPanel(
      baseRow({
        inputTokens: 0,
        cachedTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      })
    );

    expect(markup).toContain('--');
  });

  it('colors the cache hit rate cell using the low/mid/high thresholds independent of success rate', () => {
    const goodMarkup = renderPanel(
      baseRow({ inputTokens: 10, cachedTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 })
    );
    const warnMarkup = renderPanel(
      baseRow({ inputTokens: 10, cachedTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0 })
    );
    const badMarkup = renderPanel(
      baseRow({ inputTokens: 10, cachedTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 })
    );

    expect(goodMarkup).toMatch(/class="[^"]*goodText[^"]*">100\.0%/);
    expect(warnMarkup).toMatch(/class="[^"]*warnText[^"]*">40\.0%/);
    expect(badMarkup).toMatch(/class="[^"]*badText[^"]*">10\.0%/);
  });
});
