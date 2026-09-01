import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import type { FarmBeaconRedactedBodyResponse, FarmContainerBeaconView } from '@/types/farm';

// 详情抽屉遥测时间线默认拉取条数：后端上限 500、默认 50，这里显式取 50 与
// 后端默认对齐（抽屉里只需近段样本，不拉全量；需要更多历史时再调）。
export const FARM_CONTAINER_BEACONS_DEFAULT_LIMIT = 50;

export interface UseFarmContainerBeaconsResult {
  // GET .../beacons 返回的裸数组（captured_at 降序），空容器为 []（非 null）。
  beacons: FarmContainerBeaconView[];
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

/**
 * 每容器遥测 beacon 数据源（用户⑤「每容器遥测内容抓取」）：
 * GET /api/farm/containers/{id}/beacons?limit=。containerId=null（抽屉未打开）
 * 时不发请求、返回空列表。
 *
 * 与 useFarmContainerDetail 一致的取舍：只在 containerId 变化时拉取一次（抽屉是
 * 短生命周期视图，不常驻），不接入轮询——遥测 beacon 不是高频刷新的运行态指标，
 * 需要最新数据时用户重开抽屉或调用 reload 即可。
 *
 * **来源边界**：返回的 beacon 列表混合两类来源，由后端 source_kind 分区
 * （declared=容器自报/声明；on_wire=mitmproxy/ebpf 真实出站抓取）。本 hook 不做
 * 过滤、原样透传裸数组；逐条来源标注由展示层（<FarmTelemetryPanel>）按 source_kind
 * 完成——on_wire 行标 on-wire、declared 行标 declared，绝不对整列笼统 claim on-wire。
 * 指纹自洽卡的 on-wire 列已接入「逐字段各取该来源最近一条带值的信标」派生（见
 * <FarmTelemetryPanel> pickLatestBeaconFieldValue），本 hook 只原样透传裸数组、不参与
 * 选值。
 *
 * 请求失败时把 error 原样透传给调用方就地呈现（AsyncPanel error 态），不吞掉
 * 也不伪造空成功——空列表只应来自后端真实返回的 []（空容器/窗口内无样本）。
 */
export function useFarmContainerBeacons(
  containerId: string | null,
  limit: number = FARM_CONTAINER_BEACONS_DEFAULT_LIMIT
): UseFarmContainerBeaconsResult {
  const { t } = useTranslation();
  const [beacons, setBeacons] = useState<FarmContainerBeaconView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!containerId) {
      setBeacons([]);
      setError('');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await farmApi.getContainerBeacons(containerId, { limit });
      // 后端契约是裸数组；防御性地校验一次，异常形状按空列表处理而非崩溃。
      setBeacons(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('farm.error.load_failed');
      setBeacons([]);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [containerId, limit, t]);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId, limit]);

  return { beacons, loading, error, reload };
}

export interface UseFarmBeaconRedactedBodyResult {
  // 后端返回的完整脱敏 body 响应（null=尚未加载/未启用/失败清空）。
  data: FarmBeaconRedactedBodyResponse | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

/**
 * 单条 beacon「完整脱敏 body」按需数据源（用户③「看完整 body」）：
 * GET /api/farm/containers/{id}/beacons/{beaconID}/redacted-body。
 *
 * **按需触发，绝不默认全量拉取**：只有 `enabled=true` 且 containerId 存在、beaconId 为
 * 正整数时才发请求（详情抽屉里显式点「看完整 body」才把 enabled 置 true）。任一前提
 * 不满足（抽屉未展开该段 / 旧编排器缺 beacon_id / 容器缺失）时清空 data、不发请求——
 * 与 useFarmContainerBeacons 一致的短生命周期取舍，不接入轮询。
 *
 * **优雅降级**：请求失败（旧编排器无此端点 404/501、beacon 存储未装配 503、网络异常
 * 等）时把 error 原样透传给调用方，由展示层就地提示「完整 body 暂不可用」并回退到已有
 * 截断预览，不吞掉、不伪造成功、不整页报错。
 */
export function useFarmBeaconRedactedBody(
  containerId: string | null,
  beaconId: number | null,
  enabled: boolean
): UseFarmBeaconRedactedBodyResult {
  const { t } = useTranslation();
  const [data, setData] = useState<FarmBeaconRedactedBodyResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const canFetch = enabled && !!containerId && typeof beaconId === 'number' && beaconId > 0;

  const reload = useCallback(async () => {
    if (!canFetch || !containerId || beaconId == null) {
      setData(null);
      setError('');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const resp = await farmApi.getBeaconRedactedBody(containerId, beaconId);
      setData(resp);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('farm.error.load_failed');
      setData(null);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [canFetch, containerId, beaconId, t]);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canFetch, containerId, beaconId]);

  return { data, loading, error, reload };
}
