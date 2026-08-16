import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import { useFarmStore } from '@/stores';
import type {
  FarmContainerDetailView,
  FarmKeepaliveSeriesResponse,
  FarmProbeCadenceView,
  FarmResourceSeriesResponse,
  FarmUsageItem,
} from '@/types/farm';

export interface UseFarmContainerDetailResult {
  detail: FarmContainerDetailView | null;
  keepalive: FarmKeepaliveSeriesResponse | null;
  resources: FarmResourceSeriesResponse | null;
  // 用户④「请求间隔 DTO」：探针到达节奏（scope="farm_probe_cadence"），与
  // usage 各自独立请求/独立失败态，互不连累（见下方 reload 注释）。
  probeCadence: FarmProbeCadenceView | null;
  // 本容器绑定账号的 CPA 累计用量（scope="cpa_account_cumulative"，从
  // GET /api/farm/usage 全量结果里按 container_id 匹配出的单条，未匹配到
  // （如账号从未产生过用量）时为 null，不是 error）。
  usage: FarmUsageItem | null;
  loading: boolean;
  /** 仅覆盖 getContainerDetail（主详情）失败；只有它失败才应该让整个抽屉落 error 态。 */
  error: string;
  /** 心跳时序独立失败态，不连累主详情或资源时序。 */
  keepaliveError: string;
  /** 资源时序独立失败态，不连累主详情或心跳时序。 */
  resourcesError: string;
  /** 探针节奏独立失败态，不连累主详情或用量。 */
  probeCadenceError: string;
  /** 用量独立失败态，不连累主详情或探针节奏。 */
  usageError: string;
  reload: () => Promise<void>;
}

// 详情抽屉时序窗口：近 24h、1h 分桶——与 httpapi/observability.go
// enrichContainerView 计算 SuccessRate24h/NextKeepaliveEstimate 用的
// keepaliveObservedIntervalBucketStep（1h）保持一致口径，避免抽屉里的图表
// 分桶宽度和列表页 24h 成功率的统计口径对不上。
const DETAIL_SERIES_WINDOW = '24h';
const DETAIL_SERIES_STEP = '1h';

/**
 * 容器详情抽屉数据源：GET /api/farm/containers/{id} 聚合详情 +
 * .../keepalive + .../resources + .../probe-cadence 四条时序/明细 + 一次
 * GET /api/farm/usage 全量（design.md 决策4/6，tasks.md P0-9
 * <FarmContainerDetail>；probe-cadence/usage 是用户④「请求间隔 DTO」P7
 * 新增）。containerId=null（抽屉未打开）时不发请求。
 *
 * 五个请求并行发起（Promise.allSettled），各自独立捕获错误、互不连累：
 * getContainerDetail 成功即可打开抽屉并渲染主详情，即便其余四条其中任意
 * 一条 reject（网络抖动/鉴权/500）；那一条只把自己的 error 状态置位，供
 * <FarmContainerDetail> 在对应区块单独展示错误态，不影响已成功的主详情或
 * 其它请求。只有 getContainerDetail 自身失败才通过 `error` 让整个抽屉落
 * error 态（见 <FarmContainerDetail> 用 AsyncPanel 包裹主详情）。
 *
 * usage 用 getUsage()（不传 env，聚合全部已绑定 env）取全量后按
 * `container_id === containerId` 在内存里过滤——usage 端点本身不支持按
 * 容器过滤，复用既有端点比新增一个专用查询参数更小侵入（本波不做后端
 * 改动，只改 apps/web/）。取不到匹配项时 usage 为 null，不是 error（账号
 * 可能从未产生过任何请求）。
 *
 * 注：telemetry 未装配时 keepalive/resources/probe-cadence 会返回空
 * buckets/intervals 而非 error，属于正常空态，不会走到这里的 error 分支。
 */
export function useFarmContainerDetail(containerId: string | null): UseFarmContainerDetailResult {
  const { t } = useTranslation();
  const isConfigured = useFarmStore((state) => state.isConfigured);
  const [detail, setDetail] = useState<FarmContainerDetailView | null>(null);
  const [keepalive, setKeepalive] = useState<FarmKeepaliveSeriesResponse | null>(null);
  const [resources, setResources] = useState<FarmResourceSeriesResponse | null>(null);
  const [probeCadence, setProbeCadence] = useState<FarmProbeCadenceView | null>(null);
  const [usage, setUsage] = useState<FarmUsageItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [keepaliveError, setKeepaliveError] = useState('');
  const [resourcesError, setResourcesError] = useState('');
  const [probeCadenceError, setProbeCadenceError] = useState('');
  const [usageError, setUsageError] = useState('');

  const reload = useCallback(async () => {
    if (!isConfigured || !containerId) {
      setDetail(null);
      setKeepalive(null);
      setResources(null);
      setProbeCadence(null);
      setUsage(null);
      setError('');
      setKeepaliveError('');
      setResourcesError('');
      setProbeCadenceError('');
      setUsageError('');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    setKeepaliveError('');
    setResourcesError('');
    setProbeCadenceError('');
    setUsageError('');

    const [detailResult, keepaliveResult, resourcesResult, probeCadenceResult, usageResult] =
      await Promise.allSettled([
        farmApi.getContainerDetail(containerId),
        farmApi.getContainerKeepalive(containerId, {
          window: DETAIL_SERIES_WINDOW,
          step: DETAIL_SERIES_STEP,
        }),
        farmApi.getContainerResources(containerId, {
          window: DETAIL_SERIES_WINDOW,
          step: DETAIL_SERIES_STEP,
        }),
        farmApi.getContainerProbeCadence(containerId),
        farmApi.getUsage(),
      ]);

    const toMessage = (reason: unknown) =>
      reason instanceof Error ? reason.message : t('farm.error.load_failed');

    if (detailResult.status === 'fulfilled') {
      setDetail(detailResult.value ?? null);
    } else {
      setDetail(null);
      setError(toMessage(detailResult.reason));
    }

    if (keepaliveResult.status === 'fulfilled') {
      setKeepalive(keepaliveResult.value ?? null);
    } else {
      setKeepalive(null);
      setKeepaliveError(toMessage(keepaliveResult.reason));
    }

    if (resourcesResult.status === 'fulfilled') {
      setResources(resourcesResult.value ?? null);
    } else {
      setResources(null);
      setResourcesError(toMessage(resourcesResult.reason));
    }

    if (probeCadenceResult.status === 'fulfilled') {
      setProbeCadence(probeCadenceResult.value ?? null);
    } else {
      setProbeCadence(null);
      setProbeCadenceError(toMessage(probeCadenceResult.reason));
    }

    if (usageResult.status === 'fulfilled') {
      const items = Array.isArray(usageResult.value?.items) ? usageResult.value.items : [];
      setUsage(items.find((item) => item.container_id === containerId) ?? null);
    } else {
      setUsage(null);
      setUsageError(toMessage(usageResult.reason));
    }

    setLoading(false);
  }, [containerId, isConfigured, t]);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId, isConfigured]);

  return {
    detail,
    keepalive,
    resources,
    probeCadence,
    usage,
    loading,
    error,
    keepaliveError,
    resourcesError,
    probeCadenceError,
    usageError,
    reload,
  };
}
