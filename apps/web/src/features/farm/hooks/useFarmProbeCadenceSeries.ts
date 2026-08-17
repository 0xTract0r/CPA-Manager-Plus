import { useCallback, useEffect, useMemo, useState } from 'react';
import { farmApi } from '@/services/api/farm';
import type { FarmProbeCadenceView } from '@/types/farm';

export interface FarmProbeCadenceSeries {
  /** 相邻探针到达间隔（秒），按到达顺序；空窗口/无样本时为空数组。 */
  intervals: number[];
  /** 由 intervals 求平均得出的实测均值（秒），样本 <=1 时缺失。 */
  avgObservedSeconds?: number;
  sampleCount: number;
}

export interface UseFarmProbeCadenceSeriesResult {
  /** containerId → 该容器的探针到达间隔序列；未取到的容器不在 map 里。 */
  seriesById: Map<string, FarmProbeCadenceSeries>;
}

// intervals sparkline 只需要少量最近样本即可看出节奏形状；limit 收窄到 40，
// 既够画「最近 N 次间隔」又不拉大响应体。窗口沿用后端默认 24h。
const PROBE_CADENCE_SPARKLINE_LIMIT = 40;

function toSeries(view: FarmProbeCadenceView): FarmProbeCadenceSeries {
  return {
    intervals: Array.isArray(view.intervals_seconds) ? view.intervals_seconds : [],
    avgObservedSeconds: view.next_expected_window?.avg_observed_seconds_24h,
    sampleCount: view.sample_count ?? 0,
  };
}

/**
 * P2-C5「请求节奏 sparkline」：为一组已接入农场、有下一次探针的容器批量取
 * GET .../probe-cadence 的 intervals_seconds，供账号面板每行画「最近 N 次探针
 * 到达间隔」sparkline。
 *
 * **扇出边界（有意识的取舍）**：账号面板此前刻意不逐行拉 probe-cadence 以免网络
 * 扇出（见 FarmAccountsPanel 注释）。sparkline 需要 intervals 数组，容器视图不
 * 携带该字段，只能按容器取。这里把扇出**收敛成一次批量拉取**：只对传入的
 * containerId 集合（调用方已过滤为 running/degraded 的已绑定容器——只有这些容器
 * 才有下一次探针/间隔样本，数量受住宅代理容量上限天然约束，通常个位数）发起
 * Promise.allSettled，且**只在集合变化时取一次**（不接 30s 轮询——间隔是历史
 * 序列，不需要近实时刷新），把扇出成本压到最低。单个容器失败静默跳过（该行退回
 * 无 sparkline），不阻断其余行。
 */
export function useFarmProbeCadenceSeries(
  containerIds: string[]
): UseFarmProbeCadenceSeriesResult {
  const [seriesById, setSeriesById] = useState<Map<string, FarmProbeCadenceSeries>>(new Map());

  // 稳定化 id 集合的身份：按内容（排序后 join）派生 key，避免调用方每次渲染传入
  // 新数组引用就重新拉取。
  const idsKey = useMemo(() => [...containerIds].sort().join('|'), [containerIds]);

  // load 把 setState 全部收在 await 之后（空集合同样走 Promise.allSettled([])
  // 这条恒异步路径），effect 体内不做任何同步 setState，避免级联渲染。isCurrent
  // 由 effect 清理翻转，丢弃过期批次结果，防旧集合覆盖新集合的在途请求。
  const load = useCallback(
    async (isCurrent: () => boolean) => {
      const ids = idsKey ? idsKey.split('|') : [];
      const results = await Promise.allSettled(
        ids.map((id) =>
          farmApi
            .getContainerProbeCadence(id, { limit: PROBE_CADENCE_SPARKLINE_LIMIT })
            .then((view) => ({ id, view }))
        )
      );
      if (!isCurrent()) return;
      const next = new Map<string, FarmProbeCadenceSeries>();
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.view) {
          next.set(r.value.id, toSeries(r.value.view));
        }
      }
      setSeriesById(next);
    },
    [idsKey]
  );

  // 本 effect 唯一职责就是「向外部系统（编排器 probe-cadence 端点）取数据、在异步
  // 结果回来后 setState」，正是 react-hooks 规则文档自身认可的 effect 用途。规则的
  // React-Compiler 启发式对「把 N 个 API 响应本地聚合成一个 Map 再 setState」这类合法
  // 异步取数模式误报（对照 useFarmCapacity/useFarmAccounts 只 setState 单个不透明 API
  // 返回值即放行），且误报定位落在 cleanup 行，故用块级 disable 覆盖整个 effect。与本
  // 仓库既有 farm hooks 对 react-hooks 摩擦的处理一致（多处 eslint-disable）。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    let cancelled = false;
    load(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return { seriesById };
}
