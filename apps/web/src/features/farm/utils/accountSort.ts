/**
 * 账号健康表列排序纯函数（用户点4「账号健康表排序」）。
 *
 * 账号面板此前只能按筛选收窄、无法排序，operator 想「先看最异常 / 用量最高」的
 * 账号得肉眼扫。这里把「关键列 → 可比较键」的映射和比较逻辑抽成纯函数，与
 * <FarmAccountsPanel> 的渲染解耦，便于单测覆盖各列升降序 + 稳定次序，不必渲染
 * 整个面板。
 *
 * 设计取舍：
 * - 认证态按「严重度」排序而非字母序——operator 关心的是「谁最需要处理」，故用
 *   AUTH_STATE_SEVERITY 显式排位（越异常数值越大），desc 时最严重的排最前。
 * - device_id 源同理按「越偏离真实容器同步越靠前」的严重度排。
 * - 名称按本地化字符串比较；用量按请求活跃度数值比较。
 * - 每个键都追加 name 升序作为稳定次序 tiebreak，避免同键行在重排时抖动。
 */

import type { FarmAccountAuthState } from './health';
import type { FarmDeviceIDSource } from '@/types/farm';

/** 可排序的列键。 */
export const FARM_ACCOUNT_SORT_KEYS = [
  'name',
  'authState',
  'bind',
  'deviceIdSource',
  'usage',
  'lastRefresh',
] as const;
export type FarmAccountSortKey = (typeof FARM_ACCOUNT_SORT_KEYS)[number];

export type SortDirection = 'asc' | 'desc';

export interface FarmAccountSortState {
  key: FarmAccountSortKey;
  direction: SortDirection;
}

/**
 * 认证态严重度（越大越异常，用于「异常优先」排序）。healthy 最低（0），
 * unprovisioned/auto_quarantined 最高——都属「当前不可出站」。unknown 介于
 * 中间偏低（信息缺失但非确证故障）。initializing（冷启动过渡态）排在 healthy 之上、
 * unknown 之下的低区——它是「刚 onboard、暂视为非异常」的中性态，不该被排到异常区。
 * liveness_unconfirmed（无法确认存活）排在 unknown 之上、确证故障态之下——它比「根本
 * 不知道」更值得关注（曾确认过、现在确认不了），但不是确证的 disabled/reauth/隔离终态。
 */
export const AUTH_STATE_SEVERITY: Record<FarmAccountAuthState, number> = {
  healthy: 0,
  initializing: 1,
  unknown: 2,
  liveness_unconfirmed: 3,
  operator_disabled: 4,
  needs_reauth: 5,
  unprovisioned: 6,
  auto_quarantined: 7,
};

/** device_id 源严重度（越大越偏离「真实容器同步」，用于排序）。 */
export const DEVICE_ID_SOURCE_SEVERITY: Record<FarmDeviceIDSource, number> = {
  container_synced: 0,
  synthetic: 1,
  unknown: 2,
  drift: 3,
};

/** 绑定态排序权重：已绑定(1) > 未绑定(0)。 */
function bindRank(farmBound: boolean | undefined): number {
  return farmBound ? 1 : 0;
}

/** 参与排序的单行描述子（面板按各列同源口径派生后传入）。 */
export interface FarmAccountSortRow {
  /** 主展示名（note 优先，回退 account/name）——名称列排序键。 */
  name: string;
  /** 认证态 6 态——认证态列按严重度排序。 */
  authState: FarmAccountAuthState;
  /** 是否已绑定容器（契约字段 farm_bound）——绑定态列排序键。 */
  farmBound?: boolean;
  /** device_id 展示口径来源（契约字段 device_id_source）——来源列排序键。 */
  deviceIdSource?: FarmDeviceIDSource;
  /** 用量活跃度（请求次数近似）——用量列排序键。 */
  usage: number;
  /** 最近刷新时间（RFC3339 或 epoch ms 字符串）——按时间排序，空排最后。 */
  lastRefresh?: string;
}

/** 名称本地化升序，作为所有键的稳定 tiebreak。 */
function compareName(a: FarmAccountSortRow, b: FarmAccountSortRow): number {
  return a.name.localeCompare(b.name);
}

/** 把 lastRefresh 解析成可比较的毫秒数；缺失/非法 → NaN（排最后）。 */
function refreshMs(value: string | undefined): number {
  if (!value) return NaN;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * 主键差值（升序语义，不含方向、不含 tiebreak）。lastRefresh 的缺失值用
 * NaN 标记，交由 compareFarmAccountRows 做「恒排最后（方向无关）」处理。
 */
function primaryDiff(a: FarmAccountSortRow, b: FarmAccountSortRow, key: FarmAccountSortKey): number {
  switch (key) {
    case 'name':
      return compareName(a, b);
    case 'authState':
      return AUTH_STATE_SEVERITY[a.authState] - AUTH_STATE_SEVERITY[b.authState];
    case 'bind':
      return bindRank(a.farmBound) - bindRank(b.farmBound);
    case 'deviceIdSource': {
      const sa = a.deviceIdSource ? DEVICE_ID_SOURCE_SEVERITY[a.deviceIdSource] : -1;
      const sb = b.deviceIdSource ? DEVICE_ID_SOURCE_SEVERITY[b.deviceIdSource] : -1;
      return sa - sb;
    }
    case 'usage':
      return a.usage - b.usage;
    case 'lastRefresh':
      // 有值 - 有值 的毫秒差；NaN 情形在 compareFarmAccountRows 里单独兜底。
      return refreshMs(a.lastRefresh) - refreshMs(b.lastRefresh);
  }
}

/**
 * 带方向的比较。desc 翻转主键差值但**不翻转 tiebreak**——保证同主键行无论
 * 升降序都保持名称升序的稳定次序，避免重排抖动。lastRefresh 缺失值恒排最后，
 * 与排序方向无关（避免升序时空值跑最前）。
 */
export function compareFarmAccountRows(
  a: FarmAccountSortRow,
  b: FarmAccountSortRow,
  sort: FarmAccountSortState
): number {
  if (sort.key === 'lastRefresh') {
    const ma = refreshMs(a.lastRefresh);
    const mb = refreshMs(b.lastRefresh);
    const aMissing = Number.isNaN(ma);
    const bMissing = Number.isNaN(mb);
    if (aMissing && bMissing) return compareName(a, b);
    if (aMissing) return 1; // a 无时间 → 恒排最后
    if (bMissing) return -1;
  }
  const primary = primaryDiff(a, b, sort.key);
  if (primary === 0) return compareName(a, b);
  return sort.direction === 'desc' ? -primary : primary;
}

/**
 * 稳定排序（不原地修改入参）。默认排序建议：认证态严重度 desc（异常优先），
 * 由调用方作为初始 sort 传入。
 */
export function sortFarmAccountRows<T extends FarmAccountSortRow>(
  rows: readonly T[],
  sort: FarmAccountSortState
): T[] {
  return [...rows].sort((a, b) => compareFarmAccountRows(a, b, sort));
}
