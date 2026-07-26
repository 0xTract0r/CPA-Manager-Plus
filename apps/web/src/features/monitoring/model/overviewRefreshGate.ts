// 概览聚合(重的那套 stats：summary/timeline/图表/账号-API Key 汇总等 7d/30d 全量)后台
// 自动刷新的降频门。
//
// 背景：监控页的自动刷新会同时驱动两路请求——「最新请求流(events)」和「概览聚合」。
// events 体量可控、用户期望它按所选 autoRefreshMs(可低至 5s)贴近实时刷新；概览聚合在
// 7d/30d 档是全量重查，没必要每 5s 猛拉一遍。这里用一个「最小刷新间隔门」把「同窗后台
// 自动刷新」这一路的概览时钟前移降频到至少 OVERVIEW_MIN_REFRESH_INTERVAL_MS 一次。
//
// 门只作用于「同窗后台自动 tick」的 nowMs 前移。切时间窗(scope 变化)、手动刷新、用量
// 导入导出后强制刷新、首屏首拉都不受门限制：切窗时概览请求的 fromMs/toMs/granularity/
// filters/searchQuery 随 timeRange/筛选直接变化 → request 变 → 概览实例立即重拉(与本门
// 正交，天然不被挡，首拉锚点用被门限的旧 nowMs，滚动窗 ≤30s 末端偏移可忽略)；手动/强制
// 刷新传 force 直接前移 nowMs；首屏由初始时钟直接拉取。events 一路完全不看这个门，仍按
// autoRefreshMs 刷。
//
// 由于外层 tick 频率就是用户选择的 autoRefreshMs，固定 30s 的最小间隔门叠加外层 tick，
// 实际概览刷新节奏 = 不小于 30s 的最小 tick 倍数，等价于「max(autoRefreshMs, 30s)」：
//   autoRefreshMs=5s  → 每 6 个 tick(~30s)前移一次概览
//   autoRefreshMs=10s → 每 3 个 tick(~30s)
//   autoRefreshMs=30s → 每 1 个 tick(30s)
//   autoRefreshMs=60s → 每 1 个 tick(60s，>=30s 门每次都开)
//   autoRefreshMs=关  → 外层不 tick，两路都不刷
// 因此这里不需要把 autoRefreshMs 传进来，只需一个固定下限门 + 外层 tick 频率即可。

export const OVERVIEW_MIN_REFRESH_INTERVAL_MS = 30_000;

export interface OverviewClockState {
  /**
   * 概览聚合请求锚定的「当前时刻」。只按降频门/scope 重锚前移，不随事件流每个 tick 前移，
   * 从而让概览聚合请求在同窗后台刷新时保持稳定、不被每 5s 重新发起。
   */
  nowMs: number;
  /** 上次真正前移概览时钟的时刻，用于判定距今是否已达最小刷新间隔。 */
  lastAdvanceAtMs: number;
}

export const createOverviewClock = (nowMs: number): OverviewClockState => ({
  nowMs,
  lastAdvanceAtMs: nowMs,
});

// 纯判定：本次后台 tick 是否应该前移概览时钟。
// - force=true：手动刷新 / 用量导入导出后强制刷新等用户主动动作，立即前移，绕过降频门。
// - 否则：距上次前移 >= minIntervalMs 才前移（同窗后台自动刷新降频）。
export const shouldAdvanceOverviewClock = ({
  nowMs,
  lastAdvanceAtMs,
  minIntervalMs = OVERVIEW_MIN_REFRESH_INTERVAL_MS,
  force = false,
}: {
  nowMs: number;
  lastAdvanceAtMs: number;
  minIntervalMs?: number;
  force?: boolean;
}): boolean => {
  if (force) return true;
  return nowMs - lastAdvanceAtMs >= Math.max(0, minIntervalMs);
};

// 应用一次概览时钟前移判定：未达门限(且非 force)时返回原引用，让 React setState 短路重渲染
// 并保持概览聚合请求参数稳定（不重新发起请求）；达门限/force 时返回新时钟。
export const advanceOverviewClock = (
  previous: OverviewClockState,
  options: { nowMs: number; minIntervalMs?: number; force?: boolean }
): OverviewClockState => {
  if (
    !shouldAdvanceOverviewClock({
      nowMs: options.nowMs,
      lastAdvanceAtMs: previous.lastAdvanceAtMs,
      minIntervalMs: options.minIntervalMs,
      force: options.force,
    })
  ) {
    return previous;
  }
  return { nowMs: options.nowMs, lastAdvanceAtMs: options.nowMs };
};
