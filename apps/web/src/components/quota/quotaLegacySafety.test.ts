import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { apiCallApi } from '@/services/api/apiCall';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { getQuotaCredentialStoreKey } from '@/utils/quota/credentialScope';
import { fetchCodexQuota } from '@/utils/quota';
import { CODEX_CONFIG, GEMINI_CLI_CONFIG } from './quotaConfigs';
import { refreshQuotaWithConfig } from './quotaRefresh';

vi.mock('@/services/api/apiCall', () => ({
  apiCallApi: { request: vi.fn() },
  getApiCallErrorMessage: () => 'fixture error',
}));
vi.mock('@/utils/quota', async (original) => ({
  ...(await original<typeof import('@/utils/quota')>()),
  fetchCodexQuota: vi.fn(),
}));

const t = ((key: string) => key) as TFunction;
const file = {
  name: 'gemini.json',
  id: 'runtime-1',
  type: 'gemini-cli',
  provider: 'gemini-cli',
  authIndex: 'index-1',
  project_id: 'synthetic-project',
  account: 'fixture@example.test (synthetic-project)',
};
const scope = { apiBase: 'https://captured.example.test', managementKey: 'synthetic-only' };
const responseMetadata = { hasStatusCode: true, header: {}, bodyText: '' };
const quotaResponse = {
  ...responseMetadata,
  statusCode: 200,
  body: { buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.75 }] },
};
const assist = (id: string, creditAmount: number) => ({
  ...responseMetadata,
  statusCode: 200,
  body: { paidTier: { id, availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount }] } },
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
const run = (target = file, isCurrent = () => true) =>
  refreshQuotaWithConfig({
    config: GEMINI_CLI_CONFIG,
    file: target,
    setQuota: useQuotaStore.getState().setGeminiCliQuota,
    t,
    requestScope: scope,
    isCurrent,
  });

beforeEach(() => {
  useQuotaStore.getState().clearQuotaCache();
  vi.mocked(apiCallApi.request).mockReset();
  vi.mocked(fetchCodexQuota).mockReset();
});

describe('legacy quota safety adapters', () => {
  it('publishes Gemini buckets immediately and enriches its tier and credits within captured scope', async () => {
    const supplement = deferred<ReturnType<typeof assist>>();
    vi.mocked(apiCallApi.request)
      .mockResolvedValueOnce(quotaResponse)
      .mockReturnValueOnce(supplement.promise);
    const result = await run();
    expect(result?.status === 'error' ? result.error : undefined).toBeUndefined();
    expect(result).toMatchObject({ status: 'success' });
    const key = getQuotaCredentialStoreKey(file);
    expect(useQuotaStore.getState().geminiCliQuota[key]).toMatchObject({
      status: 'success',
      tierId: null,
    });
    expect(useQuotaStore.getState().geminiCliQuota[key].buckets).toHaveLength(1);
    expect(apiCallApi.request).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(apiCallApi.request).mock.calls)
      expect(call[1]).toMatchObject({ baseURL: 'https://captured.example.test/v0/management' });
    supplement.resolve(assist('g1-ultra-tier', 100));
    await flush();
    expect(useQuotaStore.getState().geminiCliQuota[key]).toMatchObject({
      tierId: 'g1-ultra-tier',
      creditBalance: 100,
    });
    const options = useQuotaStore.persist.getOptions();
    const persisted = options.partialize!(useQuotaStore.getState());
    const restored = options.merge!(
      JSON.parse(JSON.stringify(persisted)),
      useQuotaStore.getState()
    );
    expect(restored.geminiCliQuota[key]).toMatchObject({
      tierId: 'g1-ultra-tier',
      creditBalance: 100,
    });
  });

  it('does not let old Gemini supplementary data overwrite a same-name replacement', async () => {
    const old = deferred<ReturnType<typeof assist>>();
    vi.mocked(apiCallApi.request)
      .mockResolvedValueOnce(quotaResponse)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(quotaResponse)
      .mockResolvedValueOnce(assist('g1-pro-tier', 5));
    await run();
    const replacement = {
      ...file,
      id: 'runtime-2',
      project_id: 'replacement-project',
      account: 'replacement@example.test (replacement-project)',
    };
    await run(replacement);
    await flush();
    old.resolve(assist('g1-ultra-tier', 100));
    await flush();
    expect(
      useQuotaStore.getState().geminiCliQuota[getQuotaCredentialStoreKey(replacement)]
    ).toMatchObject({ tierId: 'g1-pro-tier', creditBalance: 5 });
  });

  it('drops Gemini supplementary results after the quota connection scope is cleared', async () => {
    const old = deferred<ReturnType<typeof assist>>();
    vi.mocked(apiCallApi.request)
      .mockResolvedValueOnce(quotaResponse)
      .mockReturnValueOnce(old.promise);
    await run();
    useQuotaStore.getState().activateQuotaCacheScope('new-connection');
    old.resolve(assist('g1-ultra-tier', 100));
    await flush();
    expect(useQuotaStore.getState().geminiCliQuota).toEqual({});
  });

  it('does not fetch again when a connection changes while a reset credit is consumed', async () => {
    const consumption = deferred<
      typeof responseMetadata & { statusCode: number; body: Record<string, never> }
    >();
    vi.mocked(apiCallApi.request).mockReturnValueOnce(consumption.promise);
    let current = true;
    const request = CODEX_CONFIG.resetQuota!(
      { ...file, type: 'codex', provider: 'codex' },
      t,
      scope,
      { isCurrent: () => current }
    );
    current = false;
    consumption.resolve({ ...responseMetadata, statusCode: 200, body: {} });
    await expect(request).rejects.toThrow('auth_files.delete_scope_changed');
    expect(fetchCodexQuota).not.toHaveBeenCalled();
    expect(apiCallApi.request).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiCallApi.request).mock.calls[0][1]).toMatchObject({
      baseURL: 'https://captured.example.test/v0/management',
    });
  });
});
