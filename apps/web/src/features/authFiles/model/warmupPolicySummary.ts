import type { AuthFileAccountScheduling } from '@/types';

export interface WarmupStageSummary {
  name: string;
  start: number;
  end: number;
  requests: number | null;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const nonnegative = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** 只读当前配置，不把源码默认60天当成任意服务器的实设周期。 */
export function parseWarmupCurve(raw: unknown): WarmupStageSummary[] | null {
  const stages = record(raw)['warmup-curve'];
  if (!Array.isArray(stages) || !stages.length) return null;
  const result: WarmupStageSummary[] = [];
  for (const [index, value] of stages.entries()) {
    const row = record(value);
    const start = nonnegative(row['min-age-days']);
    const end = nonnegative(row['max-age-days']);
    const name = typeof row.name === 'string' ? row.name : '';
    if (
      !name ||
      start === null ||
      end === null ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start !== (index ? result[index - 1].end : 0) ||
      (end === 0 ? index !== stages.length - 1 : end <= start)
    )
      return null;
    result.push({ name, start, end, requests: nonnegative(row['daily-budget']) });
  }
  return result;
}

export function deriveWarmupProgress(
  view: AuthFileAccountScheduling | null | undefined,
  curve: WarmupStageSummary[] | null
) {
  const age = nonnegative(view?.warmup?.age_days);
  const days = age === null ? null : Math.floor(age);
  const last = curve?.[curve.length - 1];
  const total = last && last.end > 0 ? last.end : null;
  const anchor =
    typeof view?.first_production_at === 'string' && !view.first_production_at.startsWith('0001-')
      ? Date.parse(view.first_production_at)
      : NaN;
  const end = total !== null && Number.isFinite(anchor) ? anchor + total * 86400000 : NaN;
  return {
    age: days,
    total,
    unbounded: last?.end === 0,
    percent: days !== null && total !== null ? Math.min(100, (days / total) * 100) : null,
    expectedAt:
      Number.isFinite(end) && end <= 8640000000000000 ? new Date(end).toISOString() : null,
  };
}

export function quotaWindowSummaries(view?: AuthFileAccountScheduling | null) {
  const windows = record(record(view?.quota_utilization).windows);
  return ['five_hour', 'seven_day'].map((key) => {
    const data = record(windows[key]);
    const percent = nonnegative(data.utilization_percent);
    return { key, percent: percent !== null && percent <= 100 ? percent : null };
  });
}
