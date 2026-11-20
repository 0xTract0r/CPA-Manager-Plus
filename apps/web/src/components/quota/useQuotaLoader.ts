/** 旧配额页使用与 accounts 相同的刷新生命周期，并捕获连接和凭据身份。 */
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthFileItem } from '@/types';
import { useQuotaStore } from '@/stores';
import { useAuthStore } from '@/stores/useAuthStore';
import { resolveCredentialIdentity } from '@/utils/authFileCredentialIdentity';
import { getQuotaStoreKey, getScopedQuotaState, type LegacyQuotaConfig as QuotaConfig } from './quotaConfigs';
import { refreshQuotaWithConfig, type QuotaSetter } from './quotaRefresh';

type QuotaScope = 'page' | 'all';

// store key 允许复用 auth_index；请求边界还必须核对 runtime/account，防同索引换号。
const credentialFingerprint = (file: AuthFileItem) => {
  const identity = resolveCredentialIdentity(file);
  return JSON.stringify([identity.physicalName, identity.runtimeId, identity.authIndex,
    identity.provider, identity.accountId, identity.accountSnapshot]);
};

const DEFAULT_QUOTA_REFRESH_CONCURRENCY = 4;

async function runWithConcurrencyLimit<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  worker: (item: TInput, index: number) => Promise<TOutput>
): Promise<TOutput[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOutput[] = [];
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    })
  );

  return results;
}

export function useQuotaLoader<TState, TData>(config: QuotaConfig<TState, TData>, files: AuthFileItem[]) {
  const { t } = useTranslation();
  const quota = useQuotaStore(config.storeSelector);
  const setQuota = useQuotaStore((state) => state[config.storeSetter]) as QuotaSetter<TState>;
  const filesRef = useRef(files);
  filesRef.current = files;
  const identities = new Map(files.map((file) => [getQuotaStoreKey(config, file), credentialFingerprint(file)]));
  const previousIdentities = useRef(identities);
  const replacedKeys = new Set([...identities].filter(([key, identity]) => previousIdentities.current.has(key) && previousIdentities.current.get(key) !== identity).map(([key]) => key));
  // 同索引换号先从本次 render 隐去旧证据，再清理对应缓存；避免一帧显示旧账号额度。
  const visibleQuota = replacedKeys.size ? Object.fromEntries(Object.entries(quota).filter(([key]) => !replacedKeys.has(key))) : quota;
  useEffect(() => {
    previousIdentities.current = identities;
    if (!replacedKeys.size) return;
    setQuota((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => !replacedKeys.has(key))));
  }, [config, files, setQuota]);
  const mountedRef = useRef(true);
  const connectionGeneration = useRef(0);
  const requestIdRef = useRef(0);
  const loadingRef = useRef(false);
  const loadingCallback = useRef<((loading: boolean) => void) | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = useAuthStore.subscribe((state, previous) => {
      if (state.apiBase === previous.apiBase && state.managementKey === previous.managementKey) return;
      connectionGeneration.current += 1;
      requestIdRef.current += 1;
      loadingRef.current = false;
      loadingCallback.current?.(false);
    });
    return () => {
      mountedRef.current = false;
      connectionGeneration.current += 1;
      requestIdRef.current += 1;
      unsubscribe();
    };
  }, []);

  const captureRequest = useCallback((file: AuthFileItem) => {
    const { apiBase, managementKey } = useAuthStore.getState();
    const generation = connectionGeneration.current;
    const identity = credentialFingerprint(file);
    const matchesIdentity = (candidate: AuthFileItem) => credentialFingerprint(candidate) === identity;
    const isCurrent = () => {
      const current = useAuthStore.getState();
      const matches = filesRef.current.filter(matchesIdentity);
      return mountedRef.current && connectionGeneration.current === generation &&
        current.apiBase === apiBase && current.managementKey === managementKey &&
        matches.length === 1 && !matches[0].disabled;
    };
    return {requestScope: {apiBase, managementKey}, isCurrent, generation, matchesIdentity};
  }, []);

  const loadQuota = useCallback(async (
    targets: AuthFileItem[], scope: QuotaScope,
    setLoading: (loading: boolean, scope?: QuotaScope | null) => void
  ) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const requestId = ++requestIdRef.current;
    loadingCallback.current = setLoading;
    const requests = targets.map((file) => ({file, ...captureRequest(file)}));
    setLoading(true, scope);
    try {
      await runWithConcurrencyLimit(requests, DEFAULT_QUOTA_REFRESH_CONCURRENCY, async (request) => {
        if (requestId !== requestIdRef.current || !request.isCurrent()) return;
        return refreshQuotaWithConfig({config, file: request.file, setQuota, t,
          requestScope: request.requestScope,
          isCurrent: () => requestId === requestIdRef.current && request.isCurrent(),
          currentState: getScopedQuotaState(config, config.storeSelector(useQuotaStore.getState()), request.file),
        });
      });
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
        loadingRef.current = false;
        loadingCallback.current = null;
      }
    }
  }, [captureRequest, config, setQuota, t]);
  return {quota: visibleQuota, loadQuota, captureRequest};
}
