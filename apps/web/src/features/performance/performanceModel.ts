import type { PerformanceGroup, PerformanceMetric } from './types';
import type { AuthFileItem } from '@/types/authFile';
import { normalizeAuthIndex } from '@/utils/usage';
import { buildLegacyAuthIndexAliases } from '@/features/monitoring/legacyAuthIndexAliases';
export const THRESHOLD_KEY = 'cpamp.performance.thresholds.v1';
export interface PerformanceThresholds {
  latencySeconds: number;
  minTps: number;
  minSamples: number;
}
export const DEFAULT_THRESHOLDS: PerformanceThresholds = {
  latencySeconds: 60,
  minTps: 10,
  minSamples: 30,
};
export function normalizeThresholds(value: unknown): PerformanceThresholds {
  const candidate = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const valid = (key: keyof PerformanceThresholds, max: number) => {
    const number = Number(candidate[key]);
    return Number.isFinite(number) && number > 0 && number <= max
      ? number
      : DEFAULT_THRESHOLDS[key];
  };
  return {
    latencySeconds: valid('latencySeconds', 3600),
    minTps: valid('minTps', 100000),
    minSamples: Math.ceil(valid('minSamples', 1000000)),
  };
}
export function readThresholds(): PerformanceThresholds {
  try {
    return normalizeThresholds(JSON.parse(localStorage.getItem(THRESHOLD_KEY) || 'null'));
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

export function parseThresholdDraft(
  draft: Record<keyof PerformanceThresholds, string>
): PerformanceThresholds | null {
  const latencySeconds = Number(draft.latencySeconds);
  const minTps = Number(draft.minTps);
  const minSamples = Number(draft.minSamples);
  if (
    !Number.isFinite(latencySeconds) ||
    latencySeconds <= 0 ||
    latencySeconds > 3600 ||
    !Number.isFinite(minTps) ||
    minTps <= 0 ||
    minTps > 100000 ||
    !Number.isInteger(minSamples) ||
    minSamples <= 0 ||
    minSamples > 1000000
  )
    return null;
  return { latencySeconds, minTps, minSamples };
}

export type PerformanceAccountIdentity = {
  email: string;
  name: string;
  note: string;
  provider: string;
  historical?: boolean;
};
export type PerformanceAccountSnapshot = {
  id?: string;
  auth_indices?: string[];
  source_hashes?: string[];
  account_snapshot?: string;
  auth_label_snapshot?: string;
  auth_provider_snapshot?: string;
};
const accountText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const accountEmail = (value: unknown) => {
  const text = accountText(value);
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text) ? text : '';
};
export function buildPerformanceAccountDirectory(
  files: AuthFileItem[],
  snapshots: PerformanceAccountSnapshot[] = []
) {
  const directory = new Map<string, PerformanceAccountIdentity | null>();
  const insert = (key: string, value: PerformanceAccountIdentity) => {
    if (!directory.has(key)) directory.set(key, value);
    else if (directory.get(key) !== value) directory.set(key, null);
  };
  for (const file of files) {
    const provider = accountText(file.provider || file.type).toLowerCase();
    const identity = {
      email: accountEmail(file.email) || accountEmail(file.account),
      name: accountText(file.label) || accountText(file.name),
      note: accountText(file.note),
      provider,
    };
    const index = normalizeAuthIndex(file.auth_index ?? file.authIndex);
    for (const key of new Set([
      index,
      accountText(file.name),
      identity.email.toLowerCase(),
      ...buildLegacyAuthIndexAliases(file),
    ])) {
      if (!key) continue;
      insert(JSON.stringify([provider, key]), identity);
      insert(JSON.stringify(['', key]), identity);
    }
  }
  const currentKeys = new Set(directory.keys());
  for (const snapshot of snapshots) {
    const email =
      accountEmail(snapshot.account_snapshot) || accountEmail(snapshot.auth_label_snapshot);
    const name = accountText(snapshot.auth_label_snapshot);
    if (!email && !name) continue;
    const provider = accountText(snapshot.auth_provider_snapshot).toLowerCase();
    // 当前邮箱与供应商唯一对应时才复用备注，历史邮箱本身仍标注来源。
    const current = email
      ? directory.get(JSON.stringify([provider, email.toLowerCase()]))
      : undefined;
    const identity: PerformanceAccountIdentity = {
      email,
      name: current?.name || name,
      note: current?.note || '',
      provider: current?.provider || provider,
      historical: true,
    };
    for (const rawKey of [
      snapshot.id,
      ...(snapshot.auth_indices || []),
      ...(snapshot.source_hashes || []),
    ]) {
      const key = normalizeAuthIndex(rawKey);
      if (!key) continue;
      for (const compound of [
        JSON.stringify([identity.provider, key]),
        JSON.stringify(['', key]),
      ]) {
        if (!currentKeys.has(compound)) insert(compound, identity);
      }
    }
  }
  return directory;
}
export function resolvePerformanceAccount(
  row: { account_key: string; provider?: string },
  directory: ReturnType<typeof buildPerformanceAccountDirectory>
): PerformanceAccountIdentity | undefined {
  const key = normalizeAuthIndex(row.account_key) || row.account_key;
  const provider = accountText(row.provider).toLowerCase();
  const exact = directory.get(JSON.stringify([provider, key]));
  if (exact) return exact;
  const unique = directory.get(JSON.stringify(['', key]));
  if (unique && (!provider || !unique.provider || provider === unique.provider)) return unique;
  const email = accountEmail(row.account_key);
  return email ? { email, name: '', note: '', provider } : undefined;
}
export function performanceStatus(
  group: PerformanceGroup,
  thresholds: PerformanceThresholds
): 'insufficient' | 'slow' | 'healthy' {
  if (
    group.latency_ms.samples < thresholds.minSamples ||
    group.total_tps.samples < thresholds.minSamples
  )
    return 'insufficient';
  return (group.latency_ms.p95 !== null &&
    group.latency_ms.p95 > thresholds.latencySeconds * 1000) ||
    (group.total_tps.p10 !== null && group.total_tps.p10 < thresholds.minTps)
    ? 'slow'
    : 'healthy';
}
export const coverage = (metric: PerformanceMetric) => `${metric.samples} / ${metric.eligible}`;
export const metricNumber = (value: number | null | undefined, digits = 1) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString(undefined, { maximumFractionDigits: digits });
export const milliseconds = (value: number | null | undefined) =>
  value == null ? '—' : `${metricNumber(value / 1000, 2)} s`;
