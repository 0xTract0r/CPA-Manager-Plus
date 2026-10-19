import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCallApi } from '@/services/api/apiCall';
import { fetchXaiSubscription } from './xaiSubscription';
import { XAI_CLI_CHAT_PROXY_BASE_URL } from './constants';

vi.mock('@/services/api/apiCall', () => ({ apiCallApi: { request: vi.fn() } }));
const file = { name: 'xai.json', type: 'xai', authIndex: 'xai-1' };
const result = (body: unknown, statusCode = 200) => ({
  statusCode,
  hasStatusCode: true,
  header: {},
  body,
  bodyText: '',
});
const requests = vi.mocked(apiCallApi.request);

describe('xAI subscription lookup', () => {
  beforeEach(() => {
    requests.mockReset();
  });

  it('uses credential-scoped GETs and resolves the reported Heavy account', async () => {
    requests
      .mockResolvedValueOnce(result({ subscriptionTier: 'SuperGrokPro' }))
      .mockResolvedValueOnce(result({ subscription_tier_display: 'SuperGrok Heavy' }));
    const subscription = await fetchXaiSubscription(file);
    expect(subscription).toMatchObject({ planType: 'SuperGrok Heavy', source: 'user' });
    expect(subscription?.observedAtMs).toBeGreaterThan(0);
    expect(requests).toHaveBeenCalledTimes(1);
    expect(requests.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({
        authIndex: 'xai-1',
        method: 'GET',
        url: `${XAI_CLI_CHAT_PROXY_BASE_URL}/user?include=subscription`,
      }),
    ]);
    expect(requests.mock.calls[0][0].header?.Authorization).toBe('Bearer $TOKEN$');
  });

  it.each([
    ['GrokPro', 'SuperGrok'],
    ['SuperGrokLite', 'SuperGrok Lite'],
    ['SuperGrokPlus', 'SuperGrok Plus'],
    ['XBasic', 'X Basic'],
    ['XPremium', 'X Premium'],
    ['XPremiumPlus', 'X Premium+'],
    ['Free', 'Free'],
  ])('normalizes the live tier %s', async (tier, planType) => {
    requests
      .mockResolvedValueOnce(result({ subscription_tier: tier }))
      .mockResolvedValueOnce(result({}));
    expect(await fetchXaiSubscription(file)).toMatchObject({ planType, source: 'user' });
  });

  it('lets live Free override a stale Heavy settings label', async () => {
    requests
      .mockResolvedValueOnce(result({ subscriptionTier: 'Free' }))
      .mockResolvedValueOnce(result({ subscription_tier_display: 'SuperGrok Heavy' }));
    expect(await fetchXaiSubscription(file)).toMatchObject({ planType: 'Free', source: 'user' });
  });

  it.each([null, '', 'FuturePlan', 'constructor'])(
    'does not promote a null/unknown live tier %s',
    async (tier) => {
      requests
        .mockResolvedValueOnce(result({ subscriptionTier: tier }))
        .mockResolvedValueOnce(result({ subscription_tier_display: 'SuperGrok Heavy' }));
      expect(await fetchXaiSubscription(file)).toMatchObject({ planType: null, source: 'user' });
    }
  );

  it('uses a settings display name when the live request is unavailable', async () => {
    requests
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(
        result(JSON.stringify({ subscriptionTierDisplay: 'SuperGrok Heavy' }))
      );
    expect(await fetchXaiSubscription(file)).toMatchObject({
      planType: 'SuperGrok Heavy',
      source: 'settings',
    });
    expect(requests.mock.calls[1][0].url).toBe(`${XAI_CLI_CHAT_PROXY_BASE_URL}/settings`);
  });

  it('treats rejected/malformed metadata as optional', async () => {
    requests
      .mockResolvedValueOnce(result({ subscriptionTier: 'SuperGrokPro' }, 403))
      .mockResolvedValueOnce(result('invalid json'));
    expect(await fetchXaiSubscription(file)).toBeNull();
  });

  it('forwards the captured scope and cancellation signal, with a bounded timeout', async () => {
    const signal = new AbortController().signal;
    requests.mockResolvedValue(result({}));
    await fetchXaiSubscription(file, { signal, timeout: 2000 });
    expect(requests.mock.calls[0][1]).toMatchObject({ signal, timeout: 2000 });
    await fetchXaiSubscription(file, { signal, timeout: 12000 });
    expect(requests.mock.calls[2][1]).toMatchObject({ signal, timeout: 8000 });
  });

  it('discards responses after cancellation', async () => {
    const controller = new AbortController();
    requests.mockImplementation(async () => {
      controller.abort();
      return result({ subscriptionTier: 'SuperGrokPro' });
    });
    expect(await fetchXaiSubscription(file, { signal: controller.signal })).toBeNull();
  });

  it('does not send requests without a credential or after cancellation', async () => {
    expect(await fetchXaiSubscription({ name: 'missing.json' })).toBeNull();
    const controller = new AbortController();
    controller.abort();
    expect(await fetchXaiSubscription(file, { signal: controller.signal })).toBeNull();
    expect(requests).not.toHaveBeenCalled();
  });

  it('bounds background requests across multiple batches and skips stale queued work', async () => {
    const pending: Array<(value: ReturnType<typeof result>) => void> = [];
    requests.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const first = fetchXaiSubscription(file);
    const second = fetchXaiSubscription({ ...file, authIndex: 'xai-2' });
    let active = true;
    const third = fetchXaiSubscription({ ...file, authIndex: 'xai-3' }, undefined, () => active);
    await vi.waitFor(() => expect(requests).toHaveBeenCalledTimes(2));
    active = false;
    pending.forEach((resolve) => resolve(result({ subscriptionTier: 'SuperGrokPro' })));
    expect(
      (await Promise.all([first, second, third])).map((value) => value?.planType ?? null)
    ).toEqual(['SuperGrok Heavy', 'SuperGrok Heavy', null]);
    expect(requests).toHaveBeenCalledTimes(2);
  });

  it('does not accept a payload without an explicit upstream success status', async () => {
    requests.mockResolvedValue({
      ...result({ subscriptionTier: 'SuperGrokPro' }),
      hasStatusCode: false,
    });
    expect(await fetchXaiSubscription(file)).toBeNull();
  });

  it('timestamps the request start so an in-flight response cannot cross a credential refresh', async () => {
    const started = 1792380000000;
    let clock = started;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      requests.mockImplementation(async () => {
        clock += 30_000;
        return result({ subscriptionTier: 'SuperGrokPro' });
      });
      expect(await fetchXaiSubscription(file)).toMatchObject({ observedAtMs: started });
    } finally {
      now.mockRestore();
    }
  });
});
