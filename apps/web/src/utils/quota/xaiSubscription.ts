import type { AxiosRequestConfig } from 'axios';
import type { AuthFileItem, XaiSubscriptionInfo } from '@/types';
import { apiCallApi } from '@/services/api/apiCall';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { XAI_CLI_CHAT_PROXY_BASE_URL, XAI_REQUEST_HEADERS } from './constants';
import { createKeyedSerialTaskQueue } from './providerRefreshScheduler';

const SUBSCRIPTION_TIMEOUT_MS = 8000;
// Optional background lookups must not escape the batch refresh concurrency limit.
const subscriptionQueues = [createKeyedSerialTaskQueue(), createKeyedSerialTaskQueue()];
let subscriptionSequence = 0;
const PLANS: Readonly<Record<string, string>> = {
  free: 'Free',
  grokpro: 'SuperGrok',
  supergrok: 'SuperGrok',
  supergrokpro: 'SuperGrok Heavy',
  supergrokheavy: 'SuperGrok Heavy',
  supergroklite: 'SuperGrok Lite',
  supergrokplus: 'SuperGrok Plus',
  xbasic: 'X Basic',
  xpremium: 'X Premium',
  xpremiumplus: 'X Premium+',
  'xpremium+': 'X Premium+',
};

const normalizePlan = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  return Object.prototype.hasOwnProperty.call(PLANS, key) ? PLANS[key] : null;
};

const readRecord = (body: unknown): Record<string, unknown> | null => {
  try {
    const value = typeof body === 'string' ? JSON.parse(body) : body;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

/** Optional display metadata: never probe inference or fail a successful quota refresh. */
const lookupSubscription = async (
  file: AuthFileItem,
  requestConfig: AxiosRequestConfig | undefined,
  isCurrent: () => boolean
): Promise<XaiSubscriptionInfo | null> => {
  const authIndex = normalizeAuthIndex(file.authIndex ?? file['auth_index']);
  if (!authIndex || requestConfig?.signal?.aborted || !isCurrent()) return null;
  const configuredTimeout = requestConfig?.timeout;
  const config: AxiosRequestConfig = {
    ...requestConfig,
    timeout:
      configuredTimeout && configuredTimeout > 0
        ? Math.min(configuredTimeout, SUBSCRIPTION_TIMEOUT_MS)
        : SUBSCRIPTION_TIMEOUT_MS,
  };
  const request = async (path: string) => {
    const observedAtMs = Date.now();
    const result = await apiCallApi.request(
      {
        authIndex,
        method: 'GET',
        url: `${XAI_CLI_CHAT_PROXY_BASE_URL}${path}`,
        header: { ...XAI_REQUEST_HEADERS },
      },
      config
    );
    if (!result.hasStatusCode || result.statusCode < 200 || result.statusCode >= 300) return null;
    const record = readRecord(result.body ?? result.bodyText);
    return record ? { record, observedAtMs } : null;
  };
  // The live user endpoint wins over settings, whose label can reflect an older JWT.
  // A present null/unknown live tier must not resurrect an old paid label.
  for (const [source, path, keys] of [
    ['user', '/user?include=subscription', ['subscriptionTier', 'subscription_tier']],
    ['settings', '/settings', ['subscription_tier_display', 'subscriptionTierDisplay']],
  ] as const) {
    if (requestConfig?.signal?.aborted || !isCurrent()) return null;
    const response = await request(path).catch(() => null);
    if (requestConfig?.signal?.aborted || !isCurrent()) return null;
    if (!response) continue;
    const key = keys.find((candidate) =>
      Object.prototype.hasOwnProperty.call(response.record, candidate)
    );
    if (!key) continue;
    return {
      planType: normalizePlan(response.record[key]),
      source,
      observedAtMs: response.observedAtMs,
    };
  }
  return null;
};

/** Resolve at most two subscription lookups at once, including separate refresh batches. */
export const fetchXaiSubscription = async (
  file: AuthFileItem,
  requestConfig?: AxiosRequestConfig,
  isCurrent: () => boolean = () => true
): Promise<XaiSubscriptionInfo | null> => {
  const sequence = subscriptionSequence++;
  let result: XaiSubscriptionInfo | null = null;
  await subscriptionQueues[sequence % subscriptionQueues.length].run(String(sequence), async () => {
    result = await lookupSubscription(file, requestConfig, isCurrent);
  });
  return result;
};
