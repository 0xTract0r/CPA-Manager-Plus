import { describe, expect, it } from 'vitest';

import {
  FARM_ACCOUNT_AUTH_STATES,
  FARM_CONTAINER_LIFECYCLES,
  accountAuthStateToFarmHealthVariant,
  classifyContainerLifecycle,
  containerLifecycleToFarmHealthVariant,
  deriveAccountAuthState,
  provisioningStateToFarmHealthVariant,
  type FarmAccountAuthState,
  type FarmContainerLifecycle,
  type FarmHealthVariant,
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

  it('派生结果始终落在 5 态枚举内（无越界值）', () => {
    const inputs = [
      { autoQuarantined: true },
      { disabled: true },
      { authStatus: 'alive' },
      { authReason: 'account_token_dead' },
      { hasReauthUrl: true },
      { authStatus: 'dead' },
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
// accountAuthStateToFarmHealthVariant：5 态 → 四态色。逐值断言 + 遍历枚举确保
// 每个态都有确定映射（不落 undefined）。
// ---------------------------------------------------------------------------
describe('accountAuthStateToFarmHealthVariant', () => {
  const expectedByState: Record<FarmAccountAuthState, FarmHealthVariant> = {
    healthy: 'ok',
    needs_reauth: 'warn',
    auto_quarantined: 'err',
    operator_disabled: 'idle',
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
