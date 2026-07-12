import { useCallback, useEffect, useRef, useState } from 'react';
import { usePanelFeatureAvailability } from '@/hooks/usePanelFeatureAvailability';
import {
  usageServiceApi,
  type ApiKeyAlias,
  type ApiKeyAliasesResponse,
  type ModelPricesResponse,
  type ModelPriceSyncResponse,
  type UsageExportResponse,
  type UsageImportResponse,
  type UsageSyncCoreHistoryParams,
  type UsageSyncCoreHistoryResponse,
} from '@/services/api/usageService';
import { useAuthStore } from '@/stores';
import { clearModelPrices, loadModelPrices, saveModelPrices, type ModelPrice } from '@/utils/usage';

export interface UsagePayload {
  total_requests?: number;
  success_count?: number;
  failure_count?: number;
  total_tokens?: number;
  apis?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UseUsageDataReturn {
  usage: UsagePayload | null;
  loading: boolean;
  error: string;
  lastRefreshedAt: Date | null;
  modelPrices: Record<string, ModelPrice>;
  apiKeyAliases: ApiKeyAlias[];
  usageServiceAvailable: boolean;
  setModelPrices: (prices: Record<string, ModelPrice>) => Promise<void>;
  loadApiKeyAliases: () => Promise<void>;
  syncModelPrices: (models?: string[]) => Promise<ModelPriceSyncResponse>;
  exportUsage: () => Promise<UsageExportResponse>;
  importUsage: (file: File) => Promise<UsageImportResponse>;
  syncCoreHistory: (
    params?: UsageSyncCoreHistoryParams
  ) => Promise<UsageSyncCoreHistoryResponse>;
  loadUsage: () => Promise<void>;
}

export interface UseUsageDataOptions {
  loadUsageEvents?: boolean;
}

/** 单批同步产出的累计状态，供 UI 渲染进度。 */
export interface SyncCoreHistoryCursorProgress {
  batchCount: number;
  added: number;
  skipped: number;
  nextSince?: string;
}

export type SyncCoreHistoryOutcomeStatus = 'completed' | 'cancelled' | 'failed' | 'no_data';

export interface SyncCoreHistoryCursorOutcome extends SyncCoreHistoryCursorProgress {
  status: SyncCoreHistoryOutcomeStatus;
  error?: unknown;
}

export interface RunSyncCoreHistoryCursorLoopOptions {
  /** 首批起点；留空 = 全部历史（服务端首批语义）。 */
  since?: string;
  limit?: number;
  onProgress?: (progress: SyncCoreHistoryCursorProgress) => void;
  /** 每批之间检查一次；返回 true 表示用户已请求取消。 */
  isCancelled?: () => boolean;
}

/**
 * 按后端新分页协议（hasMore/nextSince）循环拉取 Core 历史用量，直到 hasMore=false、
 * 取消或失败。失败时保留已完成批次的累计结果与失败前的 nextSince，供断点续传重试。
 */
export async function runSyncCoreHistoryCursorLoop(
  sync: (params?: UsageSyncCoreHistoryParams) => Promise<UsageSyncCoreHistoryResponse>,
  options: RunSyncCoreHistoryCursorLoopOptions = {}
): Promise<SyncCoreHistoryCursorOutcome> {
  const { since, limit, onProgress, isCancelled } = options;

  let cursor = since;
  let batchCount = 0;
  let added = 0;
  let skipped = 0;

  for (;;) {
    if (isCancelled?.()) {
      return { status: 'cancelled', batchCount, added, skipped, nextSince: cursor };
    }

    let result: UsageSyncCoreHistoryResponse;
    try {
      result = await sync(cursor || limit !== undefined ? { since: cursor, limit } : undefined);
      // 说明：cursor 或 limit 任一存在时才传 params；首批且未指定 limit 时传 undefined，
      // 交给服务端使用默认 limit（5000）与首批语义。
    } catch (error) {
      return { status: 'failed', batchCount, added, skipped, nextSince: cursor, error };
    }

    if (result.noHistoricalData && batchCount === 0) {
      return { status: 'no_data', batchCount, added, skipped };
    }

    batchCount += 1;
    added += result.added ?? 0;
    skipped += result.skipped ?? 0;
    cursor = result.hasMore ? result.nextSince : undefined;

    onProgress?.({ batchCount, added, skipped, nextSince: cursor });

    if (!result.hasMore) {
      return { status: 'completed', batchCount, added, skipped };
    }
  }
}

export function useUsageData({
  loadUsageEvents = true,
}: UseUsageDataOptions = {}): UseUsageDataReturn {
  const managementKey = useAuthStore((state) => state.managementKey);
  const featureAvailability = usePanelFeatureAvailability();
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [modelPrices, setModelPricesState] = useState<Record<string, ModelPrice>>({});
  const [apiKeyAliases, setApiKeyAliases] = useState<ApiKeyAlias[]>([]);
  const [usageServiceAvailable, setUsageServiceAvailable] = useState(false);
  const requestIdRef = useRef(0);
  const aliasRequestIdRef = useRef(0);
  const managerServiceAvailable = featureAvailability.managerServiceAvailable;
  const modelPriceServiceBase = featureAvailability.modelPricesAvailable
    ? featureAvailability.managerServiceBase
    : '';
  const usageEventsServiceBase = featureAvailability.requestMonitoringAvailable
    ? featureAvailability.managerServiceBase
    : '';

  const getModelPricesFromApi = useCallback(async (): Promise<ModelPricesResponse> => {
    if (!modelPriceServiceBase) {
      return { prices: {} };
    }
    return usageServiceApi.getModelPrices(modelPriceServiceBase, managementKey);
  }, [managementKey, modelPriceServiceBase]);

  const getApiKeyAliasesFromApi = useCallback(async (): Promise<ApiKeyAliasesResponse> => {
    if (!modelPriceServiceBase) {
      return { items: [] };
    }
    return usageServiceApi.getApiKeyAliases(modelPriceServiceBase, managementKey);
  }, [managementKey, modelPriceServiceBase]);

  const saveModelPricesToApi = useCallback(
    async (prices: Record<string, ModelPrice>): Promise<ModelPricesResponse> => {
      if (!modelPriceServiceBase) {
        throw new Error('model_price_api_unavailable');
      }
      return usageServiceApi.saveModelPrices(modelPriceServiceBase, prices, managementKey);
    },
    [managementKey, modelPriceServiceBase]
  );

  const syncModelPricesFromApi = useCallback(
    async (models?: string[]): Promise<ModelPriceSyncResponse> => {
      if (!modelPriceServiceBase) {
        throw new Error('model_price_sync_requires_usage_service');
      }
      return usageServiceApi.syncModelPrices(modelPriceServiceBase, managementKey, models);
    },
    [managementKey, modelPriceServiceBase]
  );

  const exportUsageFromApi = useCallback(async (): Promise<UsageExportResponse> => {
    if (!usageEventsServiceBase) {
      throw new Error('usage_import_export_requires_usage_service');
    }
    return usageServiceApi.exportUsage(usageEventsServiceBase, managementKey);
  }, [managementKey, usageEventsServiceBase]);

  const importUsageToApi = useCallback(
    async (file: File): Promise<UsageImportResponse> => {
      if (!usageEventsServiceBase) {
        throw new Error('usage_import_export_requires_usage_service');
      }
      return usageServiceApi.importUsage(usageEventsServiceBase, file, managementKey);
    },
    [managementKey, usageEventsServiceBase]
  );

  const syncCoreHistoryFromApi = useCallback(
    async (params?: UsageSyncCoreHistoryParams): Promise<UsageSyncCoreHistoryResponse> => {
      if (!usageEventsServiceBase) {
        throw new Error('usage_import_export_requires_usage_service');
      }
      return usageServiceApi.syncCoreHistory(usageEventsServiceBase, managementKey, params);
    },
    [managementKey, usageEventsServiceBase]
  );

  const loadModelPricesFromStorage = useCallback(async () => {
    const fallbackPrices = loadModelPrices();
    try {
      const response = await getModelPricesFromApi();
      const apiPrices = response.prices ?? {};
      if (Object.keys(apiPrices).length > 0) {
        setModelPricesState(apiPrices);
        clearModelPrices();
        return;
      }
      if (Object.keys(fallbackPrices).length > 0) {
        const migrated = await saveModelPricesToApi(fallbackPrices);
        setModelPricesState(migrated.prices ?? fallbackPrices);
        clearModelPrices();
        return;
      }
      setModelPricesState({});
    } catch {
      setModelPricesState(fallbackPrices);
    }
  }, [getModelPricesFromApi, saveModelPricesToApi]);

  const loadApiKeyAliases = useCallback(async () => {
    const requestId = aliasRequestIdRef.current + 1;
    aliasRequestIdRef.current = requestId;
    try {
      const response = await getApiKeyAliasesFromApi();
      if (aliasRequestIdRef.current !== requestId) return;
      setApiKeyAliases(Array.isArray(response.items) ? response.items : []);
    } catch {
      if (aliasRequestIdRef.current !== requestId) return;
      setApiKeyAliases([]);
    }
  }, [getApiKeyAliasesFromApi]);

  const loadUsage = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (!loadUsageEvents) {
      setUsageServiceAvailable(false);
      setUsage(null);
      setLastRefreshedAt(null);
      setLoading(false);
      setError('');
      return;
    }

    setLoading(true);
    setError('');

    try {
      if (!usageEventsServiceBase) {
        setUsageServiceAvailable(false);
        setUsage(null);
        setLastRefreshedAt(null);
        return;
      }
      setUsageServiceAvailable(true);
      const payload = await usageServiceApi.getUsage(usageEventsServiceBase, managementKey);
      if (requestIdRef.current !== requestId) return;
      setUsage(payload ?? null);
      setLastRefreshedAt(new Date());
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [loadUsageEvents, managementKey, usageEventsServiceBase]);

  useEffect(() => {
    void loadModelPricesFromStorage();
    void loadApiKeyAliases();
    void loadUsage();
  }, [loadApiKeyAliases, loadModelPricesFromStorage, loadUsage]);

  const setModelPrices = useCallback(
    async (prices: Record<string, ModelPrice>) => {
      setModelPricesState(prices);
      try {
        const response = await saveModelPricesToApi(prices);
        setModelPricesState(response.prices ?? prices);
        clearModelPrices();
      } catch {
        saveModelPrices(prices);
      }
    },
    [saveModelPricesToApi]
  );

  const syncModelPrices = useCallback(
    async (models?: string[]) => {
      const response = await syncModelPricesFromApi(models);
      setModelPricesState(response.prices ?? {});
      clearModelPrices();
      return response;
    },
    [syncModelPricesFromApi]
  );

  return {
    usage,
    loading,
    error,
    lastRefreshedAt,
    modelPrices,
    apiKeyAliases,
    usageServiceAvailable: managerServiceAvailable || usageServiceAvailable,
    setModelPrices,
    loadApiKeyAliases,
    syncModelPrices,
    exportUsage: exportUsageFromApi,
    importUsage: importUsageToApi,
    syncCoreHistory: syncCoreHistoryFromApi,
    loadUsage,
  };
}
