import { describe, expect, it } from 'vitest';

import {
  FARM_ONBOARD_REAUTH_GRACE_MS,
  accountAuthStateToFarmHealthVariant,
  deriveAccountAuthState,
  isWithinFarmOnboardGrace,
} from './health';
import { resolveFarmOnboardAtMs } from './accountTime';

// ---------------------------------------------------------------------------
// 农场新号冷启动 reauth 宽限门（fix/farm-onboard-reauth-grace）。
//
// 背景：新号刚 onboard、出口住宅代理/上游未热，头几个探测撞瞬时 401/403 → core 短暂
// 点亮 reauth 信号（reauth_url / account_token_dead / 短暂 auto_quarantine），~1-2min
// 首个真实请求成功即自愈 → 旧逻辑前端会把这个自愈型瞬态渲染成红「凭证已失效」。修法：
// 农场账号在 onboard 后 FARM_ONBOARD_REAUTH_GRACE_MS 内，把 reauth 家族态压成中性
// initializing；超窗才如实透红。真失效跨多探测持续存在，短宽限窗放过它不误伤。
//
// 本组覆盖三条硬约束用例（可证伪）：
//   ① 刚 onboard（窗口内）+ 瞬态 reauth 信号 → 显中性，不显「凭证已失效」；
//   ② 超过宽限窗 + reauth 信号 → 照常显 reauth（未被掩盖）；
//   ③ 无 reauth 信号 → 不受影响。
// 证伪演示：把 deriveAccountAuthState 的宽限折叠临时改成直接返回 base，① 会从
// initializing/idle 变回 needs_reauth/auto_quarantined + warn/err → 用例先红后绿。
// ---------------------------------------------------------------------------

// 固定测试时钟，避免依赖真实 Date.now()（render-purity 同款考量）。
const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);

describe('isWithinFarmOnboardGrace', () => {
  it('刚 onboard（elapsed=0）→ 在窗口内（左闭）', () => {
    expect(isWithinFarmOnboardGrace(NOW, NOW)).toBe(true);
  });

  it('窗口内（elapsed < 宽限窗）→ true', () => {
    expect(isWithinFarmOnboardGrace(NOW - (FARM_ONBOARD_REAUTH_GRACE_MS - 1), NOW)).toBe(true);
  });

  it('恰好到窗口右边界（elapsed === 宽限窗）→ false（右开）', () => {
    expect(isWithinFarmOnboardGrace(NOW - FARM_ONBOARD_REAUTH_GRACE_MS, NOW)).toBe(false);
  });

  it('超窗（elapsed > 宽限窗）→ false', () => {
    expect(
      isWithinFarmOnboardGrace(NOW - (FARM_ONBOARD_REAUTH_GRACE_MS + 60_000), NOW)
    ).toBe(false);
  });

  it('起点在未来（时钟漂移，elapsed<0）→ false（宁可如实透红也不永久压中性）', () => {
    expect(isWithinFarmOnboardGrace(NOW + 5_000, NOW)).toBe(false);
  });

  it('锚点缺失/非法（null/undefined/NaN）→ false（不启用宽限门）', () => {
    expect(isWithinFarmOnboardGrace(null, NOW)).toBe(false);
    expect(isWithinFarmOnboardGrace(undefined, NOW)).toBe(false);
    expect(isWithinFarmOnboardGrace(Number.NaN, NOW)).toBe(false);
  });
});

describe('resolveFarmOnboardAtMs', () => {
  it('优先 bound_at（本账号绑定时刻）', () => {
    const bound = '2026-09-03T11:59:30Z';
    const created = '2026-09-03T11:00:00Z';
    expect(resolveFarmOnboardAtMs(bound, created)).toBe(new Date(bound).getTime());
  });

  it('bound_at 缺失 → 降级 created_at（容器创建时刻）', () => {
    const created = '2026-09-03T11:00:00Z';
    expect(resolveFarmOnboardAtMs(undefined, created)).toBe(new Date(created).getTime());
  });

  it('bound_at 为 Go 零时间但 created_at 合法 → 用 created_at', () => {
    const created = '2026-09-03T11:00:00Z';
    expect(resolveFarmOnboardAtMs('0001-01-01T00:00:00Z', created)).toBe(
      new Date(created).getTime()
    );
  });

  it('两者皆为 Go 零时间 / 缺失 → null（调用方据此不启用宽限门）', () => {
    expect(resolveFarmOnboardAtMs('0001-01-01T00:00:00Z', '0001-01-01T00:00:00Z')).toBeNull();
    expect(resolveFarmOnboardAtMs(undefined, undefined)).toBeNull();
    expect(resolveFarmOnboardAtMs(null, null)).toBeNull();
  });
});

describe('deriveAccountAuthState · 冷启动 reauth 宽限门', () => {
  // 30s 前 onboard，落在 2min 宽限窗内。
  const freshOnboard = NOW - 30_000;
  // 3min 前 onboard，已超宽限窗。
  const matureOnboard = NOW - (FARM_ONBOARD_REAUTH_GRACE_MS + 60_000);

  // ① 刚 onboard（窗口内）+ 瞬态 reauth 信号 → 中性 initializing，绝不显红。
  it('① reauth_url 瞬态 + 窗口内 → initializing（idle 中性），不显 needs_reauth 红', () => {
    const state = deriveAccountAuthState({
      hasReauthUrl: true,
      farmBound: true,
      onboardAtMs: freshOnboard,
      nowMs: NOW,
    });
    expect(state).toBe('initializing');
    // 关键断言：变体是中性 idle，不是 warn/err（否则就是误显红「凭证已失效」）。
    expect(accountAuthStateToFarmHealthVariant(state)).toBe('idle');
  });

  it('① account_token_dead 瞬态 + 窗口内 → initializing', () => {
    expect(
      deriveAccountAuthState({
        authStatus: 'dead',
        authReason: 'account_token_dead',
        farmBound: true,
        onboardAtMs: freshOnboard,
        nowMs: NOW,
      })
    ).toBe('initializing');
  });

  it('① auto_quarantined 瞬态 + 窗口内 → initializing（不显红终态）', () => {
    const state = deriveAccountAuthState({
      autoQuarantined: true,
      farmBound: true,
      onboardAtMs: freshOnboard,
      nowMs: NOW,
    });
    expect(state).toBe('initializing');
    expect(accountAuthStateToFarmHealthVariant(state)).toBe('idle');
  });

  // ② 超窗 + reauth 信号 → 照常透出真态（未被宽限门掩盖）。
  it('② reauth_url + 超窗 → needs_reauth（如实透红，warn）', () => {
    const state = deriveAccountAuthState({
      hasReauthUrl: true,
      farmBound: true,
      onboardAtMs: matureOnboard,
      nowMs: NOW,
    });
    expect(state).toBe('needs_reauth');
    expect(accountAuthStateToFarmHealthVariant(state)).toBe('warn');
  });

  it('② auto_quarantined + 超窗 → auto_quarantined（红终态 err，未被掩盖）', () => {
    const state = deriveAccountAuthState({
      autoQuarantined: true,
      farmBound: true,
      onboardAtMs: matureOnboard,
      nowMs: NOW,
    });
    expect(state).toBe('auto_quarantined');
    expect(accountAuthStateToFarmHealthVariant(state)).toBe('err');
  });

  // ③ 无 reauth 信号 → 宽限门完全不碰（非 reauth 家族态原样返回）。
  it('③ healthy + 窗口内 → 仍 healthy', () => {
    expect(
      deriveAccountAuthState({
        authStatus: 'alive',
        farmBound: true,
        onboardAtMs: freshOnboard,
        nowMs: NOW,
      })
    ).toBe('healthy');
  });

  it('③ unknown + 窗口内 → 仍 unknown（不折叠成 initializing）', () => {
    expect(
      deriveAccountAuthState({
        onboardAtMs: freshOnboard,
        nowMs: NOW,
      })
    ).toBe('unknown');
  });

  it('③ unprovisioned + 窗口内 → 仍 unprovisioned（非 reauth 家族，不折叠）', () => {
    expect(
      deriveAccountAuthState({
        farmBound: false,
        provider: 'claude',
        onboardAtMs: freshOnboard,
        nowMs: NOW,
      })
    ).toBe('unprovisioned');
  });

  it('③ operator_disabled + 窗口内 → 仍 operator_disabled（非 reauth 家族，不折叠）', () => {
    expect(
      deriveAccountAuthState({
        disabled: true,
        onboardAtMs: freshOnboard,
        nowMs: NOW,
      })
    ).toBe('operator_disabled');
  });

  // 向后兼容：不传 nowMs → 完全不启用宽限门（既有单信号单测/非农场调用点不受影响）。
  it('向后兼容：给了 onboardAtMs 但不传 nowMs → needs_reauth 原样（宽限门未启用）', () => {
    expect(
      deriveAccountAuthState({
        hasReauthUrl: true,
        farmBound: true,
        onboardAtMs: freshOnboard,
      })
    ).toBe('needs_reauth');
  });

  // 无 onboard 锚点：传了 nowMs 但 onboardAtMs 缺失 → 不启用宽限门（如实透红，不臆造）。
  it('无锚点：传 nowMs 但 onboardAtMs=null → needs_reauth（如实透红）', () => {
    expect(
      deriveAccountAuthState({
        hasReauthUrl: true,
        farmBound: true,
        onboardAtMs: null,
        nowMs: NOW,
      })
    ).toBe('needs_reauth');
  });

  // 宽限门在真态派生之后叠加，不改真态优先级本身。
  it('优先级不变：auto_quarantined + disabled 同时命中 + 超窗 → auto_quarantined', () => {
    expect(
      deriveAccountAuthState({
        autoQuarantined: true,
        disabled: true,
        onboardAtMs: matureOnboard,
        nowMs: NOW,
      })
    ).toBe('auto_quarantined');
  });
});
