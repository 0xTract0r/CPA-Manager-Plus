import type { SpeedSeriesPoint } from './accountSpeedSeries';

/**
 * 周窗配额 runway 外推（Phase 3「速度收益的代价面」）：拿窗口内带
 * `header_quota_used_percent` 的事件（已由 extractSpeedSeries 按 timestamp_ms 排序），
 * 对 used% 做最小二乘线性外推，估「按当前消耗速率多久到 100%」，并与 `recoverAtMs`
 * 周窗重置时刻对照（若重置早于耗尽，说明当前速率安全）。
 *
 * 纯函数、NaN-safe，且优雅降级：
 *  - 有效 used% 样本 < 2  → status='insufficient'（只回当前 used% + 重置时刻，不硬算）
 *  - 无上升趋势（斜率<=阈值，含刚过重置的下降/平坦）→ status='flat'（同样不外推）
 *  - 所有样本同一时间戳（无法估计速率）→ status='flat'
 *  - 否则 → status='ok'，给出 runwayMs / exhaustAtMs / resetsBeforeExhaustion
 */

export type QuotaRunwayStatus = 'insufficient' | 'flat' | 'ok';

export interface QuotaRunwayResult {
  status: QuotaRunwayStatus;
  /** 最新一个 used% 样本值（0-100）；无样本为 null。 */
  latestUsedPercent: number | null;
  /** 最新 used% 样本的时间戳（ms）；无样本为 null。 */
  latestSampleMs: number | null;
  /** 最新已知的周窗重置时刻（ms）；无则 null。 */
  recoverAtMs: number | null;
  /** 按当前速率从最新样本到 100% 的剩余时长（ms）；仅 status='ok' 时非 null。 */
  runwayMs: number | null;
  /** 预计耗尽时刻（latestSampleMs + runwayMs）；仅 status='ok' 时非 null。 */
  exhaustAtMs: number | null;
  /** 周窗重置是否早于预计耗尽（true=当前速率安全）；无法判断时 null。 */
  resetsBeforeExhaustion: boolean | null;
  /** 每毫秒 used% 上升速率（正=在消耗）；无法估计时为 null。 */
  slopePctPerMs: number | null;
  /** 参与外推的 used% 有效样本数。 */
  sampleCount: number;
}

export interface ComputeQuotaRunwayOptions {
  /** 认定「有上升趋势」的最小斜率（pct/ms）。默认极小正数，防浮点噪声被当成趋势。 */
  minSlopePctPerMs?: number;
}

interface UsedSample {
  ts: number;
  used: number;
  recoverAtMs: number | null;
}

export function computeQuotaRunway(
  series: readonly SpeedSeriesPoint[] | null | undefined,
  options: ComputeQuotaRunwayOptions = {}
): QuotaRunwayResult {
  const minSlope =
    typeof options.minSlopePctPerMs === 'number' && options.minSlopePctPerMs > 0
      ? options.minSlopePctPerMs
      : 1e-12;

  const samples: UsedSample[] = [];
  for (const point of series ?? []) {
    if (!point) continue;
    const used = point.usedPercent;
    const ts = point.ts;
    if (typeof used !== 'number' || !Number.isFinite(used)) continue;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    samples.push({ ts, used, recoverAtMs: point.recoverAtMs });
  }
  samples.sort((a, b) => a.ts - b.ts);

  const sampleCount = samples.length;
  const latest = sampleCount > 0 ? samples[sampleCount - 1] : null;
  const latestUsedPercent = latest ? latest.used : null;
  const latestSampleMs = latest ? latest.ts : null;

  // 最新一个带有限恢复时刻的样本（从后往前找）。
  let recoverAtMs: number | null = null;
  for (let i = sampleCount - 1; i >= 0; i -= 1) {
    const candidate = samples[i].recoverAtMs;
    if (candidate !== null && Number.isFinite(candidate)) {
      recoverAtMs = candidate;
      break;
    }
  }

  const base: QuotaRunwayResult = {
    status: 'insufficient',
    latestUsedPercent,
    latestSampleMs,
    recoverAtMs,
    runwayMs: null,
    exhaustAtMs: null,
    resetsBeforeExhaustion: null,
    slopePctPerMs: null,
    sampleCount,
  };

  if (sampleCount < 2) {
    return base;
  }

  // 最小二乘斜率（used% 对 ts）。
  const n = sampleCount;
  let sumT = 0;
  let sumU = 0;
  for (const s of samples) {
    sumT += s.ts;
    sumU += s.used;
  }
  const meanT = sumT / n;
  const meanU = sumU / n;
  let num = 0;
  let den = 0;
  for (const s of samples) {
    const dt = s.ts - meanT;
    num += dt * (s.used - meanU);
    den += dt * dt;
  }

  if (den <= 0 || !Number.isFinite(den)) {
    // 所有样本同一时间戳：无法估计速率，按无趋势降级。
    return { ...base, status: 'flat' };
  }

  const slope = num / den; // pct per ms
  if (!Number.isFinite(slope) || slope <= minSlope) {
    // 无上升趋势（平坦或下降，如刚过周期重置）。
    return { ...base, status: 'flat', slopePctPerMs: Number.isFinite(slope) ? slope : null };
  }

  const currentUsed = latestUsedPercent as number;
  const remaining = 100 - currentUsed;
  const runwayMs = remaining <= 0 ? 0 : remaining / slope;
  const exhaustAtMs = (latestSampleMs as number) + runwayMs;
  const resetsBeforeExhaustion =
    recoverAtMs !== null && Number.isFinite(recoverAtMs) ? recoverAtMs <= exhaustAtMs : null;

  return {
    ...base,
    status: 'ok',
    slopePctPerMs: slope,
    runwayMs,
    exhaustAtMs,
    resetsBeforeExhaustion,
  };
}
