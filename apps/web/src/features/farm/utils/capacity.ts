import type {
  FarmAccountProvisioningView,
  FarmCapacityBottleneck,
  FarmCapacityResponse,
  FarmProxyCoverageView,
} from '@/types/farm';
import type { StatusBadgeVariant } from './health';

// ---------------------------------------------------------------------------
// 容量准入产品化（P2-D1）+ 供给漏斗（P2-D2）纯派生层。
//
// 全部只读、无副作用、不发请求，把 GET /api/farm/capacity 的机器码字段
// （remaining_slots / bottleneck / proxy_coverage / provisioning[]）翻译成展示语义，
// 供 FarmCapacityPanel 消费、供 vitest 直接单测。口径严格对齐后端契约，不重推资格
// 判定，也不臆造「未知」为 0（诚实边界见各函数说明）。
// ---------------------------------------------------------------------------

// per-account 供给态桶（机器码 → 展示语义），与后端 accountProvisioningView 契约
// 一一对应，前端不重推资格判定：
//   - provisioned：auto_provisioned=true，已成功自动接入。
//   - blocked_proxy：pending_reason=no_proxy，待住宅代理，fail-closed 未建容器。
//   - blocked_capacity：pending_reason=capacity_exhausted，容量已满，暂缓供给。
//   - queued：eligible=true 且无 pending，候选、排队等下一轮 reconcile。
//   - not_applicable：eligible=false 且无 pending（已绑 / 不合格 / 退避中）。
export const FARM_PROVISIONING_BUCKETS = [
  'provisioned',
  'blocked_proxy',
  'blocked_capacity',
  'queued',
  'not_applicable',
] as const;
export type FarmProvisioningBucket = (typeof FARM_PROVISIONING_BUCKETS)[number];

// 供给漏斗四段（P2-D2）：认证 → 有代理 → 有容量 → 已接入。每段是「累计到达该层」
// 的账号数，单调不增（authenticated >= hasProxy >= hasCapacity >= onboarded），
// 相邻两段之差 = 卡在该道闸门的账号数。
export const FARM_FUNNEL_STAGES = [
  'authenticated',
  'has_proxy',
  'has_capacity',
  'onboarded',
] as const;
export type FarmFunnelStage = (typeof FARM_FUNNEL_STAGES)[number];

// 桶 → 最远到达的漏斗层级（0=未进入漏斗，4=贯穿全部四层）。not_applicable 不参与
// 漏斗流量（既不算「卡在认证」也不算「已接入」，单列一旁，避免把已绑账号误判为
// 掉在认证层，或把不合格账号误算成候选）。
const BUCKET_REACHED_LEVEL: Record<FarmProvisioningBucket, number> = {
  provisioned: 4,
  queued: 3,
  blocked_capacity: 2,
  blocked_proxy: 1,
  not_applicable: 0,
};

/**
 * classifyProvisioning：单账号供给态归桶（优先级短路，互斥）。
 * 优先级 provisioned > blocked_proxy > blocked_capacity > queued > not_applicable，
 * 与后端「先判是否已接入、再判 pending 原因、再判是否候选」的语义一致。
 */
export function classifyProvisioning(
  item: FarmAccountProvisioningView,
): FarmProvisioningBucket {
  if (item.auto_provisioned) return 'provisioned';
  if (item.pending_reason === 'no_proxy') return 'blocked_proxy';
  if (item.pending_reason === 'capacity_exhausted') return 'blocked_capacity';
  if (item.eligible) return 'queued';
  return 'not_applicable';
}

// per-account 供给状态徽标（labelKey 对齐 farm.capacity.* i18n key，tone 对齐
// 设计系统 status-badge 变体）。与 classifyProvisioning 同源，供列表逐行展示。
const BUCKET_BADGE: Record<
  FarmProvisioningBucket,
  { labelKey: string; tone: StatusBadgeVariant }
> = {
  provisioned: { labelKey: 'statusProvisioned', tone: 'success' },
  blocked_proxy: { labelKey: 'statusPendingNoProxy', tone: 'warning' },
  blocked_capacity: { labelKey: 'statusPendingCapacity', tone: 'error' },
  queued: { labelKey: 'statusEligible', tone: 'muted' },
  not_applicable: { labelKey: 'statusIneligible', tone: 'muted' },
};

export function deriveProvisioningStatus(item: FarmAccountProvisioningView): {
  labelKey: string;
  tone: StatusBadgeVariant;
} {
  return BUCKET_BADGE[classifyProvisioning(item)];
}

export interface FarmSupplyFunnel {
  // 四段累计到达数，顺序对齐 FARM_FUNNEL_STAGES（单调不增）。
  stages: { stage: FarmFunnelStage; count: number }[];
  // 认证但无代理（卡在「有代理」闸门）= authenticated - has_proxy。
  blockedAtProxy: number;
  // 有代理但无容量（卡在「有容量」闸门）= has_proxy - has_capacity。
  blockedAtCapacity: number;
  // 有代理有容量、尚未接入（等下一轮 reconcile）= has_capacity - onboarded。
  awaitingOnboard: number;
  // 已自动接入。
  onboarded: number;
  // 参与漏斗流量的候选总数（= authenticated，已排除 not_applicable）。
  candidates: number;
  // 不参与漏斗的账号数（已绑 / 不合格 / 退避中）；单列一旁，不当掉队。
  notApplicable: number;
}

/**
 * buildSupplyFunnel：把 provisioning[] 折叠成四段供给漏斗（P2-D2）。
 *
 * 每个账号按其最远到达层级累加进对应段（累计口径，故单调不增）；not_applicable
 * 只计入 notApplicable，不进任何漏斗段。空数组（自动供给关闭或未跑过 reconcile）
 * 返回全零，交由展示层按契约呈现「关闭态 / 尚无评估」，不误读成异常。
 */
export function buildSupplyFunnel(
  provisioning: FarmAccountProvisioningView[],
): FarmSupplyFunnel {
  let authenticated = 0;
  let hasProxy = 0;
  let hasCapacity = 0;
  let onboarded = 0;
  let notApplicable = 0;

  for (const item of provisioning) {
    const level = BUCKET_REACHED_LEVEL[classifyProvisioning(item)];
    if (level === 0) {
      notApplicable += 1;
      continue;
    }
    if (level >= 1) authenticated += 1;
    if (level >= 2) hasProxy += 1;
    if (level >= 3) hasCapacity += 1;
    if (level >= 4) onboarded += 1;
  }

  return {
    stages: [
      { stage: 'authenticated', count: authenticated },
      { stage: 'has_proxy', count: hasProxy },
      { stage: 'has_capacity', count: hasCapacity },
      { stage: 'onboarded', count: onboarded },
    ],
    blockedAtProxy: authenticated - hasProxy,
    blockedAtCapacity: hasProxy - hasCapacity,
    awaitingOnboard: hasCapacity - onboarded,
    onboarded,
    candidates: authenticated,
    notApplicable,
  };
}

export type FarmAdmissionState = 'available' | 'exhausted' | 'unknown';

export interface FarmAdmission {
  // 还能接入多少个容器；null=两条护栏都无法判定（诚实「未知」，展示层不得当 0）。
  remainingSlots: number | null;
  // 由哪条护栏封顶（null=未知或未提供）。
  bottleneck: FarmCapacityBottleneck | null;
  state: FarmAdmissionState;
}

/**
 * deriveAdmission：把 remaining_slots + bottleneck 升级成「还能接入 N 个」叙事。
 *   - remaining_slots=null → unknown（容量未知，不伪造数字）。
 *   - remaining_slots<=0 → exhausted（已满）。
 *   - remaining_slots>0 → available（还能接入 N 个）。
 * 负值（理论不出现）按 exhausted 处理并把展示值夹到 0，避免出现「还能接入 -1 个」。
 */
export function deriveAdmission(capacity: FarmCapacityResponse): FarmAdmission {
  const rs = capacity.remaining_slots;
  const bottleneck = capacity.bottleneck ?? null;
  if (rs === null || rs === undefined) {
    return { remainingSlots: null, bottleneck: null, state: 'unknown' };
  }
  const clamped = Math.max(0, rs);
  return {
    remainingSlots: clamped,
    bottleneck,
    state: clamped > 0 ? 'available' : 'exhausted',
  };
}

export interface FarmProxyCoverage {
  configured: number;
  total: number;
  // 还没配住宅代理、无法 fail-closed 接入的账号数（total - configured，夹到 >=0）。
  uncovered: number;
}

/**
 * deriveProxyCoverage：把 proxy_coverage 折算成 M/N + 未覆盖数。
 * 后端聚合失败时字段为 null → 返回 null（诚实「未知」，展示层标注不可用，不谎称 0/0）。
 */
export function deriveProxyCoverage(
  cov: FarmProxyCoverageView | null | undefined,
): FarmProxyCoverage | null {
  if (!cov) return null;
  const configured = Math.max(0, cov.configured_accounts);
  const total = Math.max(0, cov.total_accounts);
  return { configured, total, uncovered: Math.max(0, total - configured) };
}

export type FarmAdmissionCta =
  | 'configure_proxy'
  | 'expand_capacity'
  | 'await_next_round'
  | 'none';

export interface FarmAdmissionCtaResult {
  kind: FarmAdmissionCta;
  tone: StatusBadgeVariant;
}

/**
 * deriveAdmissionCta：由聚合态推导单一可执行下一步（P2-D1），优先级对齐
 * 「先解真实 IP 泄露风险、再解容量、最后等自动接入」：
 *   1. 有账号卡在无代理，或代理覆盖有缺口 → configure_proxy（去配代理）。
 *   2. 有账号卡在容量满，或容量已耗尽 → expand_capacity（扩容或退役闲置）。
 *   3. 有候选有代理有容量、只差下一轮 → await_next_round（下一轮自动接入）。
 *   4. 其余 → none（无需动作）。
 */
export function deriveAdmissionCta(input: {
  funnel: FarmSupplyFunnel;
  admission: FarmAdmission;
  proxyCoverage: FarmProxyCoverage | null;
}): FarmAdmissionCtaResult {
  const { funnel, admission, proxyCoverage } = input;
  if (funnel.blockedAtProxy > 0 || (proxyCoverage?.uncovered ?? 0) > 0) {
    return { kind: 'configure_proxy', tone: 'warning' };
  }
  if (funnel.blockedAtCapacity > 0 || admission.state === 'exhausted') {
    return { kind: 'expand_capacity', tone: 'error' };
  }
  if (funnel.awaitingOnboard > 0) {
    return { kind: 'await_next_round', tone: 'success' };
  }
  return { kind: 'none', tone: 'muted' };
}
