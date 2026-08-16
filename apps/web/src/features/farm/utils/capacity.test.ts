import { describe, expect, it } from 'vitest';

import type {
  FarmAccountProvisioningView,
  FarmCapacityResponse,
  FarmProvisionPendingReason,
} from '@/types/farm';
import {
  buildSupplyFunnel,
  classifyProvisioning,
  deriveAdmission,
  deriveAdmissionCta,
  deriveProvisioningStatus,
  deriveProxyCoverage,
} from './capacity';

// ---------------------------------------------------------------------------
// 测试夹具：按机器码字段拼装 provisioning 条目 / capacity 响应，不硬造展示文案。
// ---------------------------------------------------------------------------
function acct(
  overrides: Partial<FarmAccountProvisioningView> & { account_id: string },
): FarmAccountProvisioningView {
  return {
    env: 'test',
    eligible: false,
    pending_reason: null,
    auto_provisioned: false,
    ...overrides,
  };
}

// 五种桶各一个代表账号：已接入 / 无代理 / 容量满 / 候选排队 / 不适用。
const provisioned = acct({ account_id: 'a-provisioned', auto_provisioned: true });
const blockedProxy = acct({
  account_id: 'a-noproxy',
  eligible: true,
  pending_reason: 'no_proxy',
});
const blockedCapacity = acct({
  account_id: 'a-capfull',
  eligible: true,
  pending_reason: 'capacity_exhausted',
});
const queued = acct({ account_id: 'a-queued', eligible: true });
const notApplicable = acct({ account_id: 'a-bound', eligible: false });

function capacity(
  overrides: Partial<FarmCapacityResponse>,
): FarmCapacityResponse {
  return {
    active_containers: 0,
    max_active_containers: 0,
    mem_available_bytes: 0,
    mem_available_threshold_bytes: 0,
    host_metrics_available: false,
    has_headroom: false,
    remaining_slots: null,
    auto_provision_enabled: true,
    provisioning: [],
    proxy_coverage: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyProvisioning：桶归属的优先级短路。重点验冲突组合（多信号同时命中）。
// ---------------------------------------------------------------------------
describe('classifyProvisioning', () => {
  it('auto_provisioned 优先于一切 pending', () => {
    expect(
      classifyProvisioning(
        acct({ account_id: 'x', auto_provisioned: true, pending_reason: 'no_proxy' }),
      ),
    ).toBe('provisioned');
  });

  it('no_proxy → blocked_proxy', () => {
    expect(classifyProvisioning(blockedProxy)).toBe('blocked_proxy');
  });

  it('capacity_exhausted → blocked_capacity', () => {
    expect(classifyProvisioning(blockedCapacity)).toBe('blocked_capacity');
  });

  it('eligible 且无 pending → queued', () => {
    expect(classifyProvisioning(queued)).toBe('queued');
  });

  it('不合格且无 pending → not_applicable', () => {
    expect(classifyProvisioning(notApplicable)).toBe('not_applicable');
  });
});

describe('deriveProvisioningStatus', () => {
  it('桶 → labelKey + tone 一一对应', () => {
    expect(deriveProvisioningStatus(provisioned)).toEqual({
      labelKey: 'statusProvisioned',
      tone: 'success',
    });
    expect(deriveProvisioningStatus(blockedProxy)).toEqual({
      labelKey: 'statusPendingNoProxy',
      tone: 'warning',
    });
    expect(deriveProvisioningStatus(blockedCapacity)).toEqual({
      labelKey: 'statusPendingCapacity',
      tone: 'error',
    });
    expect(deriveProvisioningStatus(queued)).toEqual({
      labelKey: 'statusEligible',
      tone: 'muted',
    });
    expect(deriveProvisioningStatus(notApplicable)).toEqual({
      labelKey: 'statusIneligible',
      tone: 'muted',
    });
  });
});

// ---------------------------------------------------------------------------
// buildSupplyFunnel：四段累计单调不增 + 各闸门掉队数 + not_applicable 不掺进漏斗。
// ---------------------------------------------------------------------------
describe('buildSupplyFunnel', () => {
  it('空数组 → 全零', () => {
    const f = buildSupplyFunnel([]);
    expect(f.stages.map((s) => s.count)).toEqual([0, 0, 0, 0]);
    expect(f.candidates).toBe(0);
    expect(f.notApplicable).toBe(0);
  });

  it('五桶混合：累计单调不增，相邻差=闸门掉队数，not_applicable 单列', () => {
    const f = buildSupplyFunnel([
      provisioned,
      queued,
      blockedCapacity,
      blockedProxy,
      notApplicable,
    ]);
    // authenticated=4(除 notApplicable), has_proxy=3(除 blocked_proxy),
    // has_capacity=2(再除 blocked_capacity), onboarded=1(只 provisioned)。
    expect(f.stages.map((s) => s.stage)).toEqual([
      'authenticated',
      'has_proxy',
      'has_capacity',
      'onboarded',
    ]);
    expect(f.stages.map((s) => s.count)).toEqual([4, 3, 2, 1]);
    // 单调不增。
    const counts = f.stages.map((s) => s.count);
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
    expect(f.blockedAtProxy).toBe(1);
    expect(f.blockedAtCapacity).toBe(1);
    expect(f.awaitingOnboard).toBe(1);
    expect(f.onboarded).toBe(1);
    expect(f.candidates).toBe(4);
    expect(f.notApplicable).toBe(1);
  });

  it('相邻段之差恒等于对应闸门掉队数（守恒）', () => {
    const f = buildSupplyFunnel([
      provisioned,
      provisioned,
      blockedProxy,
      blockedProxy,
      blockedCapacity,
      queued,
    ]);
    const [auth, proxy, cap, onb] = f.stages.map((s) => s.count);
    expect(auth - proxy).toBe(f.blockedAtProxy);
    expect(proxy - cap).toBe(f.blockedAtCapacity);
    expect(cap - onb).toBe(f.awaitingOnboard);
    expect(f.blockedAtProxy).toBe(2);
    expect(f.blockedAtCapacity).toBe(1);
    expect(f.awaitingOnboard).toBe(1);
    expect(f.onboarded).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// deriveAdmission：还能接入 N 个 / 已满 / 未知（null 不当 0）。
// ---------------------------------------------------------------------------
describe('deriveAdmission', () => {
  it('remaining_slots=null → unknown，不伪造数字或瓶颈', () => {
    const a = deriveAdmission(capacity({ remaining_slots: null }));
    expect(a).toEqual({ remainingSlots: null, bottleneck: null, state: 'unknown' });
  });

  it('remaining_slots>0 → available，透传 bottleneck', () => {
    const a = deriveAdmission(capacity({ remaining_slots: 3, bottleneck: 'memory' }));
    expect(a).toEqual({ remainingSlots: 3, bottleneck: 'memory', state: 'available' });
  });

  it('remaining_slots=0 → exhausted', () => {
    const a = deriveAdmission(
      capacity({ remaining_slots: 0, bottleneck: 'containers' }),
    );
    expect(a).toEqual({
      remainingSlots: 0,
      bottleneck: 'containers',
      state: 'exhausted',
    });
  });

  it('负值夹到 0 并按 exhausted（不出现负剩余）', () => {
    const a = deriveAdmission(capacity({ remaining_slots: -2 }));
    expect(a.remainingSlots).toBe(0);
    expect(a.state).toBe('exhausted');
  });
});

// ---------------------------------------------------------------------------
// deriveProxyCoverage：M/N + 未覆盖数；null 保持未知。
// ---------------------------------------------------------------------------
describe('deriveProxyCoverage', () => {
  it('null → null（不谎称 0/0）', () => {
    expect(deriveProxyCoverage(null)).toBeNull();
    expect(deriveProxyCoverage(undefined)).toBeNull();
  });

  it('configured/total → uncovered=total-configured', () => {
    expect(
      deriveProxyCoverage({ configured_accounts: 2, total_accounts: 5 }),
    ).toEqual({ configured: 2, total: 5, uncovered: 3 });
  });

  it('全覆盖 → uncovered=0', () => {
    expect(
      deriveProxyCoverage({ configured_accounts: 4, total_accounts: 4 }),
    ).toEqual({ configured: 4, total: 4, uncovered: 0 });
  });
});

// ---------------------------------------------------------------------------
// deriveAdmissionCta：单一可执行下一步的优先级。
// ---------------------------------------------------------------------------
describe('deriveAdmissionCta', () => {
  const emptyFunnel = buildSupplyFunnel([]);

  it('有账号卡无代理 → configure_proxy（最高优先）', () => {
    const funnel = buildSupplyFunnel([blockedProxy, blockedCapacity, queued]);
    expect(
      deriveAdmissionCta({
        funnel,
        admission: deriveAdmission(capacity({ remaining_slots: 0 })),
        proxyCoverage: deriveProxyCoverage({
          configured_accounts: 5,
          total_accounts: 5,
        }),
      }).kind,
    ).toBe('configure_proxy');
  });

  it('无漏斗掉队但代理覆盖有缺口 → configure_proxy', () => {
    expect(
      deriveAdmissionCta({
        funnel: emptyFunnel,
        admission: deriveAdmission(capacity({ remaining_slots: 5 })),
        proxyCoverage: deriveProxyCoverage({
          configured_accounts: 1,
          total_accounts: 3,
        }),
      }).kind,
    ).toBe('configure_proxy');
  });

  it('代理都就绪但有账号卡容量 → expand_capacity', () => {
    const funnel = buildSupplyFunnel([blockedCapacity, queued]);
    const result = deriveAdmissionCta({
      funnel,
      admission: deriveAdmission(capacity({ remaining_slots: 2 })),
      proxyCoverage: deriveProxyCoverage({
        configured_accounts: 3,
        total_accounts: 3,
      }),
    });
    expect(result.kind).toBe('expand_capacity');
    expect(result.tone).toBe('error');
  });

  it('无掉队但容量已耗尽 → expand_capacity', () => {
    expect(
      deriveAdmissionCta({
        funnel: emptyFunnel,
        admission: deriveAdmission(capacity({ remaining_slots: 0 })),
        proxyCoverage: null,
      }).kind,
    ).toBe('expand_capacity');
  });

  it('只剩候选等下一轮 → await_next_round', () => {
    const funnel = buildSupplyFunnel([queued, provisioned]);
    expect(
      deriveAdmissionCta({
        funnel,
        admission: deriveAdmission(capacity({ remaining_slots: 4 })),
        proxyCoverage: deriveProxyCoverage({
          configured_accounts: 2,
          total_accounts: 2,
        }),
      }).kind,
    ).toBe('await_next_round');
  });

  it('全部就绪、无候选 → none', () => {
    const funnel = buildSupplyFunnel([provisioned, notApplicable]);
    expect(
      deriveAdmissionCta({
        funnel,
        admission: deriveAdmission(capacity({ remaining_slots: 6 })),
        proxyCoverage: deriveProxyCoverage({
          configured_accounts: 3,
          total_accounts: 3,
        }),
      }).kind,
    ).toBe('none');
  });
});

// 类型面守卫：pending_reason 机器码集合与本地夹具保持同源，防契约漂移。
const _pendingReasons: FarmProvisionPendingReason[] = ['no_proxy', 'capacity_exhausted'];
void _pendingReasons;
