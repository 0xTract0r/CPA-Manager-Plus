import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import type {
  FarmContainerDetailView,
  FarmEnv,
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
  // GET /api/farm/usage?env=<绑定 env> 结果里按 container_id 匹配出的单条，
  // 未绑定账号（无法判定 env）或未匹配到（如账号从未产生过用量）时为
  // null，不是 error）。
  usage: FarmUsageItem | null;
  /** 主 loading：只覆盖 getContainerDetail（抽屉壳 + tabs 结构所需的核心数据）。
   *  不再等其余四条时序/明细请求 settle——它们各自有自己的 loading 子状态，
   *  慢或失败都不应该拖住已经能渲染的抽屉主体（尤其是遥测 tab，它走独立
   *  hook，本就不该被这里任何字段连累）。 */
  loading: boolean;
  /** 仅覆盖 getContainerDetail（主详情）失败；只有它失败才应该让整个抽屉落 error 态。 */
  error: string;
  /** 心跳时序独立 loading，只驱动「心跳成功率与延迟」区块自己的局部 spinner。 */
  keepaliveLoading: boolean;
  /** 心跳时序独立失败态，不连累主详情或资源时序。 */
  keepaliveError: string;
  /** 资源时序独立 loading，只驱动「资源占用」区块自己的局部 spinner。 */
  resourcesLoading: boolean;
  /** 资源时序独立失败态，不连累主详情或心跳时序。 */
  resourcesError: string;
  /** 探针节奏独立 loading，只驱动「探针保活节奏」区块自己的局部 spinner。 */
  probeCadenceLoading: boolean;
  /** 探针节奏独立失败态，不连累主详情或用量。 */
  probeCadenceError: string;
  /** 用量独立 loading，只驱动「账号 CPA 累计用量」区块自己的局部 spinner。 */
  usageLoading: boolean;
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

function isFarmEnv(value: string | undefined): value is FarmEnv {
  return value === 'test' || value === 'prod';
}

/**
 * 容器详情抽屉数据源：GET /api/farm/containers/{id} 聚合详情 +
 * .../keepalive + .../resources + .../probe-cadence 三条时序/明细 + 一次
 * GET /api/farm/usage?env=<绑定 env>（design.md 决策4/6，tasks.md P0-9
 * <FarmContainerDetail>；probe-cadence/usage 是用户④「请求间隔 DTO」P7
 * 新增）。containerId=null（抽屉未打开）时不发请求。
 *
 * 五条请求各自独立发起、独立 settle、独立更新自己的 state/loading——不再用
 * 单个 Promise.allSettled 等全部 settle 后才统一 setState（此前的耦合 bug：
 * 单一 `loading` 绑在全部 5 条 settle 后才清，抽屉壳 + 遥测 tab 会被最慢/
 * 最容易失败的 usage 拖住，即便 getContainerDetail 早已 resolve）。现在
 * getContainerDetail 一 resolve，`loading` 就清、抽屉壳与 tabs 立即可渲染；
 * 其余四条只在各自区块内用自己的 loading/error 子状态显示局部 spinner 或
 * 错误，互不连累、也不连累已渲染的主详情或遥测 tab（遥测本身走独立 hook
 * useFarmContainerBeacons，从未依赖本 hook 任何字段，此前只是被外层单一
 * loading 挡在 tabs 渲染之外）。只有 getContainerDetail 自身失败才通过
 * `error` 让整个抽屉落 error 态（见 <FarmContainerDetail> 用 AsyncPanel
 * 包裹主详情）。
 *
 * usage 用 getUsage(usageEnv) 按容器实际绑定 env 缩口径取该 env 的用量后按
 * `container_id === containerId` 在内存里过滤——usage 端点本身不支持按
 * 容器过滤，复用既有端点比新增一个专用查询参数更小侵入（本波不做后端
 * 改动，只改 apps/web/）。传入 env 而非不传（聚合全部已绑定 env）是为了
 * 避免把永久失效的 prod 哨兵账号一起拖进同一次查询——测试端容器因此偶发
 * context canceled/502（本轮修复的根因之一）。未绑定账号的容器（无 env
 * 可判定）直接跳过网络请求，本地立即给出「无匹配」结果，不打一个注定
 * 0 命中、还可能被 prod 哨兵拖垮的全量查询。取不到匹配项时 usage 为
 * null，不是 error（账号可能从未产生过任何请求）。
 *
 * 注：telemetry 未装配时 keepalive/resources/probe-cadence 会返回空
 * buckets/intervals 而非 error，属于正常空态，不会走到这里的 error 分支。
 */
export function useFarmContainerDetail(
  containerId: string | null,
  // 容器绑定账号所在 env（container.binding?.env）；未绑定为 undefined。
  // 只接受原始 string | undefined 而非要求调用方先转型，本 hook 内部用
  // isFarmEnv 校验，避免调用方传入非法值时打出一个必然出错的请求。
  bindingEnv?: string
): UseFarmContainerDetailResult {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<FarmContainerDetailView | null>(null);
  const [keepalive, setKeepalive] = useState<FarmKeepaliveSeriesResponse | null>(null);
  const [resources, setResources] = useState<FarmResourceSeriesResponse | null>(null);
  const [probeCadence, setProbeCadence] = useState<FarmProbeCadenceView | null>(null);
  const [usage, setUsage] = useState<FarmUsageItem | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [keepaliveLoading, setKeepaliveLoading] = useState(false);
  const [keepaliveError, setKeepaliveError] = useState('');
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [resourcesError, setResourcesError] = useState('');
  const [probeCadenceLoading, setProbeCadenceLoading] = useState(false);
  const [probeCadenceError, setProbeCadenceError] = useState('');
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState('');

  const reload = useCallback(async () => {
    if (!containerId) {
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
      setKeepaliveLoading(false);
      setResourcesLoading(false);
      setProbeCadenceLoading(false);
      setUsageLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    setKeepaliveLoading(true);
    setKeepaliveError('');
    setResourcesLoading(true);
    setResourcesError('');
    setProbeCadenceLoading(true);
    setProbeCadenceError('');
    setUsageLoading(true);
    setUsageError('');

    const toMessage = (reason: unknown) =>
      reason instanceof Error ? reason.message : t('farm.error.load_failed');

    const detailPromise = farmApi
      .getContainerDetail(containerId)
      .then((value) => setDetail(value ?? null))
      .catch((reason: unknown) => {
        setDetail(null);
        setError(toMessage(reason));
      })
      .finally(() => setLoading(false));

    const keepalivePromise = farmApi
      .getContainerKeepalive(containerId, {
        window: DETAIL_SERIES_WINDOW,
        step: DETAIL_SERIES_STEP,
      })
      .then((value) => setKeepalive(value ?? null))
      .catch((reason: unknown) => {
        setKeepalive(null);
        setKeepaliveError(toMessage(reason));
      })
      .finally(() => setKeepaliveLoading(false));

    const resourcesPromise = farmApi
      .getContainerResources(containerId, {
        window: DETAIL_SERIES_WINDOW,
        step: DETAIL_SERIES_STEP,
      })
      .then((value) => setResources(value ?? null))
      .catch((reason: unknown) => {
        setResources(null);
        setResourcesError(toMessage(reason));
      })
      .finally(() => setResourcesLoading(false));

    const probeCadencePromise = farmApi
      .getContainerProbeCadence(containerId)
      .then((value) => setProbeCadence(value ?? null))
      .catch((reason: unknown) => {
        setProbeCadence(null);
        setProbeCadenceError(toMessage(reason));
      })
      .finally(() => setProbeCadenceLoading(false));

    const validUsageEnv = isFarmEnv(bindingEnv) ? bindingEnv : undefined;
    const usagePromise = validUsageEnv
      ? farmApi
          .getUsage(validUsageEnv)
          .then((value) => {
            const items = Array.isArray(value?.items) ? value.items : [];
            setUsage(items.find((item) => item.container_id === containerId) ?? null);
          })
          .catch((reason: unknown) => {
            setUsage(null);
            setUsageError(toMessage(reason));
          })
          .finally(() => setUsageLoading(false))
      : Promise.resolve().then(() => {
          // 未绑定账号：不可能在 usage 里匹配到任何条目，跳过网络请求。
          setUsage(null);
          setUsageLoading(false);
        });

    await Promise.allSettled([
      detailPromise,
      keepalivePromise,
      resourcesPromise,
      probeCadencePromise,
      usagePromise,
    ]);
  }, [containerId, bindingEnv, t]);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId, bindingEnv]);

  return {
    detail,
    keepalive,
    resources,
    probeCadence,
    usage,
    loading,
    error,
    keepaliveLoading,
    keepaliveError,
    resourcesLoading,
    resourcesError,
    probeCadenceLoading,
    probeCadenceError,
    usageLoading,
    usageError,
    reload,
  };
}
