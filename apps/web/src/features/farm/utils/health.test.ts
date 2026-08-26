import { describe, expect, it } from 'vitest';

import {
  FARM_TELEMETRY_ALIVE_STATES,
  FARM_TELEMETRY_SILENCE_STATES,
  type FarmTelemetryAliveState,
  type FarmTelemetrySilenceState,
} from '@/types/farm';
import {
  FARM_ACCOUNT_AUTH_STATES,
  FARM_CONTAINER_LIFECYCLES,
  accountAuthStateToFarmHealthVariant,
  classifyContainerLifecycle,
  containerLifecycleToFarmHealthVariant,
  deriveAccountAuthState,
  farmBoundToOutboundPlatform,
  farmEnrolledToBadgeVariant,
  normalizeFarmTelemetryAliveState,
  normalizeFarmTelemetrySilenceState,
  provisioningStateToFarmHealthVariant,
  telemetryAliveStateToBadgeVariant,
  telemetrySilenceStateToBadgeVariant,
  type FarmAccountAuthState,
  type FarmContainerLifecycle,
  type FarmHealthVariant,
  type StatusBadgeVariant,
} from './health';

// ---------------------------------------------------------------------------
// deriveAccountAuthState：5 态优先级 quarantined > disabled > alive >
// needs_reauth > unknown。重点验证「多个信号同时命中时」的优先级，因为实现
// 是一串短路 if，优先级错位（如 disabled 排到 alive 之后）不会被单信号用例
// 抓到，只有冲突组合能揭示。
// ---------------------------------------------------------------------------
describe('deriveAccountAuthState', () => {
  it('单信号：auto_quarantined 布尔 → auto_quarantined', () => {
    expect(deriveAccountAuthState({ autoQuarantined: true })).toBe('auto_quarantined');
  });

  it('单信号：disabled 布尔 → operator_disabled', () => {
    expect(deriveAccountAuthState({ disabled: true })).toBe('operator_disabled');
  });

  it("单信号：authStatus='alive' → healthy", () => {
    expect(deriveAccountAuthState({ authStatus: 'alive' })).toBe('healthy');
  });

  it("单信号：authReason='account_token_dead' → needs_reauth", () => {
    expect(deriveAccountAuthState({ authReason: 'account_token_dead' })).toBe('needs_reauth');
  });

  it('单信号：hasReauthUrl → needs_reauth', () => {
    expect(deriveAccountAuthState({ hasReauthUrl: true })).toBe('needs_reauth');
  });

  it("兜底：authStatus='dead' 但无原因无 reauthUrl → needs_reauth（不误判为 unknown）", () => {
    expect(deriveAccountAuthState({ authStatus: 'dead' })).toBe('needs_reauth');
  });

  it('空输入 → unknown', () => {
    expect(deriveAccountAuthState({})).toBe('unknown');
  });

  it("authStatus='unknown' 且无任何终态信号 → unknown", () => {
    expect(deriveAccountAuthState({ authStatus: 'unknown' })).toBe('unknown');
  });

  // --- 未绑定容器的 Claude 账号 → unprovisioned（用户点4「绑定+健康才算正常」）---
  it('farmBound=false + Claude（无其它信号）→ unprovisioned', () => {
    expect(deriveAccountAuthState({ farmBound: false })).toBe('unprovisioned');
    expect(deriveAccountAuthState({ farmBound: false, provider: 'claude' })).toBe('unprovisioned');
    expect(deriveAccountAuthState({ farmBound: false, provider: 'anthropic' })).toBe(
      'unprovisioned'
    );
  });

  it('farmBound=false 但非 Claude provider → 回退 unknown（农场只管 Claude）', () => {
    expect(deriveAccountAuthState({ farmBound: false, provider: 'codex' })).toBe('unknown');
    expect(deriveAccountAuthState({ farmBound: false, provider: 'gemini' })).toBe('unknown');
  });

  it('farmBound 缺省（undefined）不触发 unprovisioned（后端过渡期防御式回退旧行为）', () => {
    expect(deriveAccountAuthState({})).toBe('unknown');
    expect(deriveAccountAuthState({ authStatus: 'alive' })).toBe('healthy');
  });

  it('冲突：farmBound=false + quarantined → auto_quarantined（隔离终态优先于未绑定）', () => {
    expect(deriveAccountAuthState({ farmBound: false, autoQuarantined: true })).toBe(
      'auto_quarantined'
    );
  });

  it('冲突：farmBound=false + disabled → operator_disabled（停用优先于未绑定）', () => {
    expect(deriveAccountAuthState({ farmBound: false, disabled: true })).toBe('operator_disabled');
  });

  it('冲突：farmBound=false + reauth_url → needs_reauth（需重认证优先于未绑定）', () => {
    expect(deriveAccountAuthState({ farmBound: false, hasReauthUrl: true })).toBe('needs_reauth');
  });

  // --- 冲突时的优先级（关键回归护栏）---
  it('冲突：quarantined + disabled 同时命中 → quarantined（隔离优先于停用）', () => {
    expect(
      deriveAccountAuthState({ autoQuarantined: true, disabled: true })
    ).toBe('auto_quarantined');
  });

  it("冲突：quarantined + authStatus='alive' → quarantined（隔离终态优先于 alive）", () => {
    expect(
      deriveAccountAuthState({ autoQuarantined: true, authStatus: 'alive' })
    ).toBe('auto_quarantined');
  });

  it("冲突：disabled + authStatus='alive' → operator_disabled（停用优先于 alive）", () => {
    expect(
      deriveAccountAuthState({ disabled: true, authStatus: 'alive' })
    ).toBe('operator_disabled');
  });

  it('冲突：disabled + reauth_url → operator_disabled（停用优先于需重认证）', () => {
    expect(
      deriveAccountAuthState({ disabled: true, hasReauthUrl: true })
    ).toBe('operator_disabled');
  });

  it("冲突：disabled + authReason='account_token_dead' → operator_disabled", () => {
    expect(
      deriveAccountAuthState({ disabled: true, authReason: 'account_token_dead' })
    ).toBe('operator_disabled');
  });

  it("冲突：alive + reauth_url → healthy（alive 优先于需重认证）", () => {
    expect(
      deriveAccountAuthState({ authStatus: 'alive', hasReauthUrl: true })
    ).toBe('healthy');
  });

  it("冲突：alive + authReason='account_token_dead' → healthy", () => {
    expect(
      deriveAccountAuthState({ authStatus: 'alive', authReason: 'account_token_dead' })
    ).toBe('healthy');
  });

  it('冲突：全部信号同时命中 → auto_quarantined（最高优先级封顶）', () => {
    expect(
      deriveAccountAuthState({
        autoQuarantined: true,
        disabled: true,
        authStatus: 'alive',
        authReason: 'account_token_dead',
        hasReauthUrl: true,
      })
    ).toBe('auto_quarantined');
  });

  it('派生结果始终落在 6 态枚举内（无越界值）', () => {
    const inputs = [
      { autoQuarantined: true },
      { disabled: true },
      { authStatus: 'alive' },
      { authReason: 'account_token_dead' },
      { hasReauthUrl: true },
      { authStatus: 'dead' },
      { farmBound: false },
      { farmBound: false, provider: 'codex' },
      {},
    ];
    for (const input of inputs) {
      expect(FARM_ACCOUNT_AUTH_STATES).toContain(deriveAccountAuthState(input));
    }
  });
});

// ---------------------------------------------------------------------------
// classifyContainerLifecycle：各容器状态字面值 → 生命周期分类。逐个分支断言，
// 含 created/starting 两个不同字面都折算 pending、orphaned→ghost、undefined→
// unbound、空串→unbound、未知值→pending 兜底。
// ---------------------------------------------------------------------------
describe('classifyContainerLifecycle', () => {
  const cases: Array<[string | undefined, FarmContainerLifecycle]> = [
    ['running', 'running'],
    ['created', 'pending'],
    ['starting', 'pending'],
    ['degraded', 'degraded'],
    ['down', 'down'],
    ['retired', 'retired'],
    ['orphaned', 'ghost'],
    [undefined, 'unbound'],
  ];

  for (const [status, expected] of cases) {
    it(`${status ?? '(undefined)'} → ${expected}`, () => {
      expect(classifyContainerLifecycle(status)).toBe(expected);
    });
  }

  it('空字符串（falsy）→ unbound', () => {
    expect(classifyContainerLifecycle('')).toBe('unbound');
  });

  it('未知状态字面值 → pending 兜底', () => {
    expect(classifyContainerLifecycle('some_unmapped_status')).toBe('pending');
    expect(classifyContainerLifecycle('exited')).toBe('pending');
  });

  it('分类结果始终落在生命周期枚举内', () => {
    for (const [status] of [...cases, ['weird'] as const]) {
      expect(FARM_CONTAINER_LIFECYCLES).toContain(classifyContainerLifecycle(status));
    }
  });
});

// ---------------------------------------------------------------------------
// provisioningStateToFarmHealthVariant：自动供给派生态 → 语义色。每个取值 +
// undefined + 未知值兜底都断言。
// ---------------------------------------------------------------------------
describe('provisioningStateToFarmHealthVariant', () => {
  const cases: Array<[string | undefined, FarmHealthVariant]> = [
    ['eligible', 'idle'],
    ['pending_no_proxy', 'warn'],
    ['pending_capacity_exhausted', 'warn'],
    ['provisioned', 'ok'],
    [undefined, 'idle'],
    ['', 'idle'],
    ['totally_unknown_state', 'idle'],
  ];

  for (const [state, expected] of cases) {
    it(`${state === undefined ? '(undefined)' : state === '' ? '(empty)' : state} → ${expected}`, () => {
      expect(provisioningStateToFarmHealthVariant(state)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// TR8：farmEnrolledToBadgeVariant / farmBoundToOutboundPlatform /
// normalizeFarmTelemetryAliveState / telemetryAliveStateToBadgeVariant。
// 重点是"字段缺失/非法值时安全兜底，不崩、不误判"——farm_enrolled 和
// telemetry_alive 目前后端投影都还没完全落地，前端在生产中会长期收到
// undefined，这条防线比"正常值映射对不对"更重要。
// ---------------------------------------------------------------------------
describe('farmEnrolledToBadgeVariant', () => {
  it('true → success（已纳管）', () => {
    expect(farmEnrolledToBadgeVariant(true)).toBe('success');
  });

  it('false → muted（未纳管·免疫农场治理，中性非异常）', () => {
    expect(farmEnrolledToBadgeVariant(false)).toBe('muted');
  });
});

describe('farmBoundToOutboundPlatform', () => {
  it('farmBound=true（农场号）→ linux（对齐容器遥测）', () => {
    expect(farmBoundToOutboundPlatform(true)).toBe('linux');
  });

  it('farmBound=false（普通号）→ mac', () => {
    expect(farmBoundToOutboundPlatform(false)).toBe('mac');
  });

  it('farmBound 缺省（undefined，理论不应发生的防御分支）→ mac 兜底，不假造已绑定', () => {
    expect(farmBoundToOutboundPlatform(undefined)).toBe('mac');
  });
});

describe('normalizeFarmTelemetryAliveState', () => {
  for (const state of FARM_TELEMETRY_ALIVE_STATES) {
    it(`合法三态值 '${state}' 原样透传`, () => {
      expect(normalizeFarmTelemetryAliveState(state)).toBe(state);
    });
  }

  it('undefined（编排器尚未透传该字段的当前实际情况）→ unknown，不崩', () => {
    expect(normalizeFarmTelemetryAliveState(undefined)).toBe('unknown');
  });

  it('空字符串 → unknown', () => {
    expect(normalizeFarmTelemetryAliveState('')).toBe('unknown');
  });

  it('未知/非法字面值 → unknown 兜底，不误判为 alive/silent', () => {
    expect(normalizeFarmTelemetryAliveState('totally_bogus_value')).toBe('unknown');
    expect(normalizeFarmTelemetryAliveState('ALIVE')).toBe('unknown'); // 大小写敏感，不做归一
  });

  it('归一化结果始终落在三态枚举内', () => {
    const inputs: Array<string | undefined> = [
      'alive',
      'silent',
      'unknown',
      undefined,
      '',
      'bogus',
    ];
    for (const input of inputs) {
      expect(FARM_TELEMETRY_ALIVE_STATES).toContain(normalizeFarmTelemetryAliveState(input));
    }
  });
});

describe('telemetryAliveStateToBadgeVariant', () => {
  const expectedByState: Record<FarmTelemetryAliveState, string> = {
    alive: 'success',
    silent: 'warning',
    unknown: 'muted',
  };

  for (const state of FARM_TELEMETRY_ALIVE_STATES) {
    it(`${state} → ${expectedByState[state]}`, () => {
      expect(telemetryAliveStateToBadgeVariant(state)).toBe(expectedByState[state]);
    });
  }
});

// ---------------------------------------------------------------------------
// accountAuthStateToFarmHealthVariant：5 态 → 四态色。逐值断言 + 遍历枚举确保
// 每个态都有确定映射（不落 undefined）。
// ---------------------------------------------------------------------------
describe('accountAuthStateToFarmHealthVariant', () => {
  const expectedByState: Record<FarmAccountAuthState, FarmHealthVariant> = {
    healthy: 'ok',
    needs_reauth: 'warn',
    auto_quarantined: 'err',
    operator_disabled: 'idle',
    unprovisioned: 'err',
    unknown: 'idle',
  };

  for (const state of FARM_ACCOUNT_AUTH_STATES) {
    it(`${state} → ${expectedByState[state]}`, () => {
      expect(accountAuthStateToFarmHealthVariant(state)).toBe(expectedByState[state]);
    });
  }

  it('枚举里每个态都有映射（无 undefined 兜底缺口）', () => {
    const validVariants: FarmHealthVariant[] = ['ok', 'warn', 'err', 'idle'];
    for (const state of FARM_ACCOUNT_AUTH_STATES) {
      expect(validVariants).toContain(accountAuthStateToFarmHealthVariant(state));
    }
  });
});

// ---------------------------------------------------------------------------
// containerLifecycleToFarmHealthVariant：生命周期分类 → 四态色。逐值断言 +
// 遍历枚举确保覆盖全部 7 个分类。
// ---------------------------------------------------------------------------
describe('containerLifecycleToFarmHealthVariant', () => {
  const expectedByLifecycle: Record<FarmContainerLifecycle, FarmHealthVariant> = {
    running: 'ok',
    pending: 'idle',
    degraded: 'warn',
    down: 'err',
    retired: 'idle',
    ghost: 'warn',
    unbound: 'idle',
  };

  for (const lifecycle of FARM_CONTAINER_LIFECYCLES) {
    it(`${lifecycle} → ${expectedByLifecycle[lifecycle]}`, () => {
      expect(containerLifecycleToFarmHealthVariant(lifecycle)).toBe(
        expectedByLifecycle[lifecycle]
      );
    });
  }

  it('枚举里每个分类都有映射（无 undefined 兜底缺口）', () => {
    const validVariants: FarmHealthVariant[] = ['ok', 'warn', 'err', 'idle'];
    for (const lifecycle of FARM_CONTAINER_LIFECYCLES) {
      expect(validVariants).toContain(containerLifecycleToFarmHealthVariant(lifecycle));
    }
  });
});

// farm-egress-resilience Change A：遥测停摆四态归一化 + 徽标变体。
describe('normalizeFarmTelemetrySilenceState 诚实兜底', () => {
  for (const state of FARM_TELEMETRY_SILENCE_STATES) {
    it(`枚举值 ${state} 原样保留`, () => {
      expect(normalizeFarmTelemetrySilenceState(state)).toBe(state);
    });
  }

  it('undefined / 空串 / 未知字面值一律回退 indeterminate（待确认），绝不臆断乐观结论', () => {
    const notOptimistic: FarmTelemetrySilenceState[] = ['active', 'idle_no_request'];
    for (const bad of [undefined, '', 'some_future_state', 'ACTIVE', 'idle']) {
      const got = normalizeFarmTelemetrySilenceState(bad);
      expect(got).toBe('indeterminate');
      expect(notOptimistic).not.toContain(got);
    }
  });
});

describe('telemetrySilenceStateToBadgeVariant 语义色', () => {
  const expected: Record<FarmTelemetrySilenceState, StatusBadgeVariant> = {
    active: 'success',
    idle_no_request: 'muted',
    proxy_dead: 'error',
    egress_blackhole: 'error',
    process_dead: 'error',
    indeterminate: 'warning',
  };
  for (const state of FARM_TELEMETRY_SILENCE_STATES) {
    it(`${state} → ${expected[state]}`, () => {
      expect(telemetrySilenceStateToBadgeVariant(state)).toBe(expected[state]);
    });
  }
});
