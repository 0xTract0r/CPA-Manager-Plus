/**
 * FarmUsagePanel 的纯派生逻辑（P2-C6/C7）。抽成独立模块以便单测覆盖聚合与
 * 备注回退规则——组件本身只做渲染，不承载可测的分支逻辑。
 */
import type { FarmUsageItem } from '@/types/farm';

// 两个「时钟」口径的机器可读 scope 常量，与后端 dto.go 的 usageScope /
// probeCadenceScope 逐字对齐（见 services/farm-orchestrator/internal/httpapi/
// dto.go）。前端用它们程序化区分「账号 CPA 累计用量」与「探针保活节奏」两个
// 完全独立的口径，不靠解析中文 note 文案（用户④「请求间隔 DTO」分栏要求）。
export const FARM_USAGE_SCOPE = 'cpa_account_cumulative';
export const FARM_PROBE_CADENCE_SCOPE = 'farm_probe_cadence';

/** 只把有限数值计入求和，undefined/NaN/Infinity 一律按 0 跳过，不伪造。 */
function finiteOrZero(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** trim 后为空串（或非字符串）时归一为 undefined，供「有值才渲染」判定。 */
function normalizeLabel(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// 账号 API 累计用量「时钟」的聚合读数（P2-C6 右钟）。这是对
// GET /api/farm/usage items[] 的真实求和，不引入任何占位/假数据。
export interface FarmUsageSummary {
  /** 去重后的账号数（优先按 account_id，缺失时回退 account_email）。 */
  accountCount: number;
  /** 去重后的容器数。 */
  containerCount: number;
  /** 累计请求数（账号 CPA 口径，含探针外真实流量，不是探针到达次数）。 */
  totalRequests: number;
  /** 累计 Token（各账号 tokens.total 求和）。 */
  totalTokens: number;
  /** 累计费用（USD）。 */
  totalCostUsd: number;
  /** items 为空——供右钟落「结构性缺席」空态（C7 ①）。 */
  isEmpty: boolean;
}

/**
 * 聚合农场用量明细为「账号 API 累计用量」时钟读数。account/container 去重用
 * Set，数值求和跳过非有限值。刻意不聚合探针节奏——那是另一个口径（左钟），
 * 两者不可相加（C6 非可加性）。
 */
export function summarizeFarmUsage(items: readonly FarmUsageItem[]): FarmUsageSummary {
  const accounts = new Set<string>();
  const containers = new Set<string>();
  let totalRequests = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;

  for (const item of items) {
    const accountKey = normalizeLabel(item.account_id) ?? normalizeLabel(item.account_email);
    if (accountKey) accounts.add(accountKey);
    const containerKey = normalizeLabel(item.container_id);
    if (containerKey) containers.add(containerKey);
    totalRequests += finiteOrZero(item.requests);
    totalTokens += finiteOrZero(item.tokens?.total);
    totalCostUsd += finiteOrZero(item.cost_usd);
  }

  return {
    accountCount: accounts.size,
    containerCount: containers.size,
    totalRequests,
    totalTokens,
    totalCostUsd,
    isEmpty: items.length === 0,
  };
}

// 用量明细行的账号标识展示口径（P2-C6 备注展示）。运营者只记备注/别名，不记
// 邮箱，故主行优先展示 note；缺 note 时回退 account_id + email 的既有口径。
export interface UsageAccountIdentity {
  /** 账号备注/别名（trim 后非空才有）；优先展示。 */
  note?: string;
  /** 农场绑定表里的 account_id（auth 文件名形式），恒作为主/副标识展示。 */
  accountId: string;
  /** 账号邮箱（trim 后非空、且不与 accountId 重复时才有），作为最弱一行。 */
  email?: string;
  /** 是否有可展示的备注，供组件决定主行样式。 */
  hasNote: boolean;
}

/**
 * 从一条用量明细派生账号标识的展示结构。备注/邮箱的「空则不渲染、重复则去重」
 * 归一在这里做一次，组件按返回结构直接渲染，不再散落 falsy 判断。
 */
export function deriveUsageAccountIdentity(
  item: Pick<FarmUsageItem, 'account_id' | 'account_email' | 'account_note'>
): UsageAccountIdentity {
  const note = normalizeLabel(item.account_note);
  const accountId = normalizeLabel(item.account_id) ?? '';
  const emailRaw = normalizeLabel(item.account_email);
  const email = emailRaw && emailRaw !== accountId ? emailRaw : undefined;
  return { note, accountId, email, hasNote: Boolean(note) };
}
