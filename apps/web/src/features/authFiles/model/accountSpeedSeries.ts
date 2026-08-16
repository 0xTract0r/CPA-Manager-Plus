import type { MonitoringAnalyticsEventRow } from '@/services/api/usageService';
import { PRIORITY_SERVICE_TIER, normalizeServiceTier } from './accountSpeedMetrics';

/**
 * 账号级速度时间序列（Phase 3）：从一批 analytics 事件明细行，抽取按 `timestamp_ms`
 * 升序的逐事件序列，供「TTFT sparkline」「service_tier 切换点检测」「配额 runway 外推」
 * 复用同一份已拉取数据（一次请求喂三块）。
 *
 * 纯函数、无副作用、NaN-safe：非有限时间戳的行无法保序直接丢弃；ttft/latency 非法归 null，
 * 由渲染方（mapSeriesToPoints 的空洞拆段 / 文案降级）处理，绝不产出 NaN 坐标。
 */

export interface SpeedSeriesPoint {
  /** 事件时间戳（ms，有限值）。 */
  ts: number;
  /** 首 token（ms）；非法/缺失为 null（sparkline 空洞拆段用）。 */
  ttftMs: number | null;
  /** 端到端耗时（ms）；非法/缺失为 null。 */
  latencyMs: number | null;
  /** 归一化 service_tier（priority=fast / 其余=default）。 */
  tier: string;
  /** 该点是否 priority（即已开 fast）。 */
  isPriority: boolean;
  /** 周窗配额已用百分比（0-100，来自上游响应头）；缺失为 null。已 clamp 到 [0,100]。 */
  usedPercent: number | null;
  /** 周窗配额恢复时刻（ms）；缺失为 null。 */
  recoverAtMs: number | null;
  /** 该事件是否失败（默认 extract 已排除失败，仅在 includeFailed 时保留）。 */
  failed: boolean;
}

export interface ExtractSpeedSeriesOptions {
  /** 是否保留失败事件（失败请求的 ttft/耗时会污染速度形状）。默认 false。 */
  includeFailed?: boolean;
}

const finiteOrNull = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const finiteNonNegOrNull = (value: number | null | undefined): number | null => {
  const n = finiteOrNull(value);
  return n !== null && n >= 0 ? n : null;
};

/**
 * 从 analytics 事件明细行抽取按 `timestamp_ms` 升序的逐事件速度序列。
 * 无有效时间戳的行丢弃（无法保序）；空输入返回 []；不产生 NaN。
 * V8 的 Array.sort 稳定，故等 ts 时保持输入相对顺序。
 */
export function extractSpeedSeries(
  events: readonly MonitoringAnalyticsEventRow[] | null | undefined,
  options: ExtractSpeedSeriesOptions = {}
): SpeedSeriesPoint[] {
  const includeFailed = options.includeFailed === true;
  const points: SpeedSeriesPoint[] = [];

  for (const row of events ?? []) {
    if (!row) continue;
    if (!includeFailed && row.failed === true) continue;

    const ts = finiteOrNull(row.timestamp_ms);
    if (ts === null) continue;

    const tier = normalizeServiceTier(row.service_tier);
    const usedRaw = finiteOrNull(row.header_quota_used_percent);
    const usedPercent = usedRaw === null ? null : Math.min(100, Math.max(0, usedRaw));

    points.push({
      ts,
      ttftMs: finiteNonNegOrNull(row.ttft_ms),
      latencyMs: finiteNonNegOrNull(row.latency_ms),
      tier,
      isPriority: tier === PRIORITY_SERVICE_TIER,
      usedPercent,
      recoverAtMs: finiteOrNull(row.header_quota_recover_at_ms),
      failed: row.failed === true,
    });
  }

  points.sort((a, b) => a.ts - b.ts);
  return points;
}

export interface TierTransition {
  /** series 中翻转后的第一个点索引（即 priority 段起点）。 */
  index: number;
  /** 翻转前的 tier（default 段）。 */
  fromTier: string;
  /** 翻转后的 tier（priority 段）。 */
  toTier: string;
  /** 该点在序列中的水平比例 index/(length-1)，供 sparkline x 定位；单点时为 0。 */
  ratio: number;
  /** 翻转点的时间戳（ms）。 */
  ts: number;
}

/**
 * 检测首个 default→priority 切换边界（用户开 fast 的那一刻）。
 * 保序扫描相邻点，返回第一处「前一点非 priority 且当前点 priority」的边界；
 * 单段 / 全程同 tier / 只有 priority→default / 空 / 单点 均返回 null。
 * 多次切换时取第一处 default→priority 边界。
 */
export function detectFirstFastTransition(
  series: readonly SpeedSeriesPoint[] | null | undefined
): TierTransition | null {
  const points = series ?? [];
  if (points.length < 2) return null;

  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    if (!prev.isPriority && curr.isPriority) {
      return {
        index: i,
        fromTier: prev.tier,
        toTier: curr.tier,
        ratio: i / (points.length - 1),
        ts: curr.ts,
      };
    }
  }

  return null;
}
