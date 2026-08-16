import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { farmApi } from '@/services/api/farm';
import { useFarmStore } from '@/stores';
import type { FarmContainerBeaconView } from '@/types/farm';

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
 * 或农场未配置时不发请求、返回空列表。
 *
 * 与 useFarmContainerDetail 一致的取舍：只在 containerId / isConfigured 变化时
 * 拉取一次（抽屉是短生命周期视图，不常驻），不接入轮询——遥测 beacon 不是
 * 高频刷新的运行态指标，需要最新数据时用户重开抽屉或调用 reload 即可。
 *
 * **诚实边界**：这些 beacon 是容器「自报 / 声明」内容（source ∈
 * declared/self-report/unknown），只证明上报管道连通，不构成反关联 on-wire
 * 证明；展示层（<FarmTelemetryPanel>）据此把 on-wire 一列灰置标注「待抓取
 * 管道」，本 hook 只负责取数与错误态透传，不做任何「已证明」的暗示。
 *
 * 请求失败时把 error 原样透传给调用方就地呈现（AsyncPanel error 态），不吞掉
 * 也不伪造空成功——空列表只应来自后端真实返回的 []（空容器/窗口内无样本）。
 */
export function useFarmContainerBeacons(
  containerId: string | null,
  limit: number = FARM_CONTAINER_BEACONS_DEFAULT_LIMIT
): UseFarmContainerBeaconsResult {
  const { t } = useTranslation();
  const isConfigured = useFarmStore((state) => state.isConfigured);
  const [beacons, setBeacons] = useState<FarmContainerBeaconView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!isConfigured || !containerId) {
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
  }, [containerId, isConfigured, limit, t]);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId, isConfigured, limit]);

  return { beacons, loading, error, reload };
}
