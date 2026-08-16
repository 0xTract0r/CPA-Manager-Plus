import type { MonitoringAnalyticsEventRow } from '@/services/api/usageService';

/**
 * 账号级速度读数（Phase 2）可复用数据层：从一批 analytics 事件明细行计算
 * 中位首 token（TTFT）、中位耗时（latency）、中位 TPS（生成阶段每秒 token）。
 *
 * TPS 口径按需求定义为「生成阶段吞吐」：`output_tokens / ((latency_ms - ttft_ms) / 1000)`，
 * 即扣掉首 token 到达前的排队/等待时间，只看正式生成阶段的 token 速率；逐事件先算再取
 * 中位。注意这与 monitoring 里 `calculateOutputTokensPerSecond`（用整段 latency）口径不同，
 * 这里刻意排除首 token 时延以反映「开没开 fast」的生成速度差异。
 *
 * 结构上同时按 `service_tier` 分组返回（priority=fast / 其余=default），Phase 2 UI 先只用
 * `overall`，分组接口留给 Phase 3「开 fast 前后对比」直接复用，避免二次重构。
 */

export const PRIORITY_SERVICE_TIER = 'priority';
export const DEFAULT_SERVICE_TIER = 'default';

export interface AccountSpeedMetricSummary {
  /** 中位首 token（ms）；样本不足 minSamples 时为 null。 */
  medianTtftMs: number | null;
  /** 中位耗时（ms）；样本不足 minSamples 时为 null。 */
  medianLatencyMs: number | null;
  /** 中位 TPS（生成阶段每秒 token）；样本不足 minSamples 时为 null。 */
  medianTps: number | null;
  /** 参与 TTFT 中位计算的有效样本数。 */
  ttftSamples: number;
  /** 参与 latency 中位计算的有效样本数。 */
  latencySamples: number;
  /** 参与 TPS 中位计算的有效样本数。 */
  tpsSamples: number;
  /** 该分组纳入统计的事件总数（成功事件，除非 includeFailed）。 */
  events: number;
}

export interface AccountSpeedMetricsResult {
  /** overall 至少有一项中位数可用时为 true；否则视为「数据不足」。 */
  hasData: boolean;
  /** 输入事件总数（含被 includeFailed 过滤掉的失败事件）。 */
  totalEvents: number;
  /** 实际纳入统计的事件数（overall.events 的别名，UI 展示「基于 N 次」用）。 */
  usedEvents: number;
  /** 全体（不区分 service_tier）的中位读数。 */
  overall: AccountSpeedMetricSummary;
  /**
   * 按归一化后的 service_tier 分组（key = 归一化 tier，空值归入 `default`）。
   * 无信息损失，Phase 3 可据此做任意维度对比。
   */
  byServiceTier: Record<string, AccountSpeedMetricSummary>;
  /** 便捷视图：service_tier=priority（即 fast）分组；无该分组事件时为 null。 */
  priorityTier: AccountSpeedMetricSummary | null;
  /** 便捷视图：非 priority（即未开 fast 的 default）分组；无该分组事件时为 null。 */
  defaultTier: AccountSpeedMetricSummary | null;
}

export interface ComputeAccountSpeedMetricsOptions {
  /** 单项中位数所需的最小有效样本数；不足则该项中位为 null。默认 1。 */
  minSamples?: number;
  /** 是否把 failed 事件也纳入统计。默认 false（失败请求会污染速度口径）。 */
  includeFailed?: boolean;
}

interface SpeedAccumulator {
  ttft: number[];
  latency: number[];
  tps: number[];
  events: number;
}

const createAccumulator = (): SpeedAccumulator => ({
  ttft: [],
  latency: [],
  tps: [],
  events: 0,
});

const isValidDuration = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** 归一化 service_tier：小写去空格；空/缺失归入 `default`（视为未开 fast）。 */
export const normalizeServiceTier = (value: string | null | undefined): string => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized || DEFAULT_SERVICE_TIER;
};

/**
 * fast(priority) 相对 default 的单指标 delta（Phase 3「前后对比」）。
 * pctChange = (fast-default)/default*100；ratio = fast/default；
 * improved = 方向正确与否（lowerIsBetter 时 fast<default 为改进，否则 fast>default 为改进）。
 * 任一值缺失/非有限，或 default==0（会除零）时，三项全 null，绝不产出 NaN/Infinity。
 */
export interface MetricDelta {
  pctChange: number | null;
  ratio: number | null;
  improved: boolean | null;
}

export const computeMetricDelta = (
  fastValue: number | null | undefined,
  defaultValue: number | null | undefined,
  options: { lowerIsBetter: boolean }
): MetricDelta => {
  const fast = typeof fastValue === 'number' && Number.isFinite(fastValue) ? fastValue : null;
  const base =
    typeof defaultValue === 'number' && Number.isFinite(defaultValue) ? defaultValue : null;
  if (fast === null || base === null || base === 0) {
    return { pctChange: null, ratio: null, improved: null };
  }
  return {
    pctChange: ((fast - base) / base) * 100,
    ratio: fast / base,
    improved: options.lowerIsBetter ? fast < base : fast > base,
  };
};

/** 数组中位数；空数组返回 null；偶数个取中间两个的平均。 */
export const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
};

const addRowToAccumulator = (acc: SpeedAccumulator, row: MonitoringAnalyticsEventRow): void => {
  acc.events += 1;

  const ttftMs = row.ttft_ms;
  const latencyMs = row.latency_ms;
  const outputTokens = row.output_tokens;

  if (isValidDuration(ttftMs)) {
    acc.ttft.push(ttftMs);
  }
  if (isValidDuration(latencyMs) && latencyMs > 0) {
    acc.latency.push(latencyMs);
  }

  // 生成阶段 TPS 需要 output_tokens>0、latency>0、ttft 有效，且生成耗时 (latency-ttft) > 0。
  // 缺 ttft 或 (latency-ttft)<=0 的事件无法反映生成阶段速率，直接跳过而不回退到整段 latency，
  // 以保持与需求定义一致、避免把首 token 排队时间算进吞吐。
  if (
    typeof outputTokens === 'number' &&
    Number.isFinite(outputTokens) &&
    outputTokens > 0 &&
    isValidDuration(latencyMs) &&
    latencyMs > 0 &&
    isValidDuration(ttftMs)
  ) {
    const generationMs = latencyMs - ttftMs;
    if (generationMs > 0) {
      acc.tps.push(outputTokens / (generationMs / 1000));
    }
  }
};

const finalizeSummary = (acc: SpeedAccumulator, minSamples: number): AccountSpeedMetricSummary => ({
  medianTtftMs: acc.ttft.length >= minSamples ? median(acc.ttft) : null,
  medianLatencyMs: acc.latency.length >= minSamples ? median(acc.latency) : null,
  medianTps: acc.tps.length >= minSamples ? median(acc.tps) : null,
  ttftSamples: acc.ttft.length,
  latencySamples: acc.latency.length,
  tpsSamples: acc.tps.length,
  events: acc.events,
});

/**
 * 从 analytics 事件明细行计算账号速度中位读数 + 按 service_tier 分组。
 * 纯函数、无副作用；输入为空或全部无效时返回 hasData=false 的「数据不足」结果，不产生 NaN。
 */
export const computeAccountSpeedMetrics = (
  events: readonly MonitoringAnalyticsEventRow[] | null | undefined,
  options: ComputeAccountSpeedMetricsOptions = {}
): AccountSpeedMetricsResult => {
  const minSamples = Math.max(1, Math.floor(options.minSamples ?? 1));
  const includeFailed = options.includeFailed === true;

  const overall = createAccumulator();
  const priority = createAccumulator();
  const nonPriority = createAccumulator();
  const byTier = new Map<string, SpeedAccumulator>();
  let totalEvents = 0;

  for (const row of events ?? []) {
    if (!row) continue;
    totalEvents += 1;
    if (!includeFailed && row.failed === true) continue;

    addRowToAccumulator(overall, row);

    const tier = normalizeServiceTier(row.service_tier);
    let tierAcc = byTier.get(tier);
    if (!tierAcc) {
      tierAcc = createAccumulator();
      byTier.set(tier, tierAcc);
    }
    addRowToAccumulator(tierAcc, row);

    if (tier === PRIORITY_SERVICE_TIER) {
      addRowToAccumulator(priority, row);
    } else {
      addRowToAccumulator(nonPriority, row);
    }
  }

  const overallSummary = finalizeSummary(overall, minSamples);
  const byServiceTier: Record<string, AccountSpeedMetricSummary> = {};
  for (const [tier, acc] of byTier) {
    byServiceTier[tier] = finalizeSummary(acc, minSamples);
  }

  const hasData =
    overallSummary.medianTtftMs !== null ||
    overallSummary.medianLatencyMs !== null ||
    overallSummary.medianTps !== null;

  return {
    hasData,
    totalEvents,
    usedEvents: overall.events,
    overall: overallSummary,
    byServiceTier,
    priorityTier: priority.events > 0 ? finalizeSummary(priority, minSamples) : null,
    defaultTier: nonPriority.events > 0 ? finalizeSummary(nonPriority, minSamples) : null,
  };
};
