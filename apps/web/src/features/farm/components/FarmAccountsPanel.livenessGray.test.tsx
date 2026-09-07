import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { FarmAccountEntry, FarmContainerView } from '@/types/farm';
import { FarmAccountsPanel } from './FarmAccountsPanel';

/**
 * farm-account-liveness-detection Phase 5 F1/F2 前端门禁（确定性 fixture，不依赖 201）。
 *
 * 断言：编排器把一个账号标成「无法确认存活」（① 账号顶层 farm_health_blind=true，或
 * ② 绑定容器 health_reason 浮现 account_token_stale）时，账号认证态卡片渲染成
 * **灰（idle）+ 告警**——不是绿（healthy/success），即便底层 account_auth_status 仍是
 * alive（F2：颜色反映最近一次真实确认，不凭陈旧缓存快照显绿）。同时对照一个真正健康
 * 的账号仍显绿，证明灰是特指、没有把健康号误伤成灰。
 *
 * 环境说明：cpamp 无 Playwright / jsdom / testing-library，测试栈是 vitest +
 * react-test-renderer（node env）。默认筛选是「正常（绑定+健康）」，会把灰态异常行滤掉，
 * 故先经 Select.onChange 切到「全部认证态」再断言。断言只看确定性的 data-* 属性
 * （data-status / data-auth-state）与 reason 子行存在性，不依赖具体文案。真实浏览器视觉
 * 截图核验（真机、真实数据）延后到 A5（部署后）——见交付说明。
 */

vi.mock('react-i18next', () => {
  const stable = {
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { language: 'en' },
  };
  return {
    initReactI18next: { type: '3rdParty', init: () => {} },
    useTranslation: () => stable,
  };
});

vi.mock('@/hooks/useTimezone', () => ({ useTimezone: () => undefined }));
vi.mock('@/hooks/useInterval', () => ({ useInterval: () => undefined }));

const accountsMock = vi.fn();
vi.mock('../hooks/useFarmAccounts', () => ({ useFarmAccounts: () => accountsMock() }));
vi.mock('../hooks/useFarmAccountState', () => ({
  useFarmAccountState: () => ({ accountStates: [], loading: false, error: '', reload: async () => {} }),
}));
vi.mock('../hooks/useFarmContainers', () => ({
  useFarmContainers: () => ({
    containers: [],
    setContainers: () => {},
    loading: false,
    error: '',
    reload: async () => {},
  }),
}));
vi.mock('../hooks/useFarmOnboard', () => ({
  useFarmOnboard: () => ({ onboardingAccountId: null, onboard: () => {} }),
}));
vi.mock('../hooks/useFarmProbeCadenceSeries', () => ({
  useFarmProbeCadenceSeries: () => ({ seriesById: new Map() }),
}));

const baseAccount = (o: Partial<FarmAccountEntry> & { name: string }): FarmAccountEntry => ({
  status: 'active',
  disabled: false,
  auto_quarantined: false,
  farm_bound: false,
  device_id_source: 'synthetic',
  ...o,
});

const baseContainer = (o: Partial<FarmContainerView> & { id: string }): FarmContainerView => ({
  device_id_masked: 'dev…0000',
  status: 'running',
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-09-04T00:00:00Z',
  ...o,
});

// ① token-stale：account_auth_status 仍是 alive（陈旧缓存假绿），但绑定容器
//    health_reason 浮现 account_token_stale → 必须显灰不显绿（F2）。
const staleAccount = baseAccount({
  name: 'acct-stale',
  farm_bound: true,
  farm_container_id: 'c-stale',
  farm_container_status: 'degraded',
  device_id_source: 'container_synced',
  last_refresh: '2026-08-01T00:00:00Z',
});
const staleContainer = baseContainer({
  id: 'c-stale',
  status: 'degraded',
  account_auth_status: 'alive',
  health_reason: 'account_token_stale',
});

// ② health-blind：账号顶层 farm_health_blind=true（core 反关联防泄漏门挡住探测），
//    容器 health_reason 正常（ok）→ 走账号级来源，同样显灰不显绿（F1）。
const blindAccount = baseAccount({
  name: 'acct-blind',
  farm_bound: true,
  farm_container_id: 'c-blind',
  farm_container_status: 'running',
  farm_health_blind: true,
  device_id_source: 'container_synced',
  last_refresh: '2026-08-15T00:00:00Z',
});
const blindContainer = baseContainer({
  id: 'c-blind',
  status: 'running',
  account_auth_status: 'alive',
  health_reason: 'ok',
});

// 对照组：真正健康（alive + 无任何无法确认存活信号）→ 仍显绿（healthy/success）。
const okAccount = baseAccount({
  name: 'acct-ok',
  farm_bound: true,
  farm_container_id: 'c-ok',
  farm_container_status: 'running',
  farm_health_blind: false,
  device_id_source: 'container_synced',
  last_refresh: '2026-09-03T00:00:00Z',
});
const okContainer = baseContainer({
  id: 'c-ok',
  status: 'running',
  account_auth_status: 'alive',
  health_reason: 'ok',
});

const renderPanel = (): ReactTestRenderer => {
  accountsMock.mockReturnValue({
    accounts: [staleAccount, blindAccount, okAccount],
    loading: false,
    error: '',
    reload: async () => {},
  });
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <FarmAccountsPanel containers={[staleContainer, blindContainer, okContainer]} />
    );
  });
  // 默认筛选 'normal' 只显健康号，把灰态异常行滤掉——切到「全部认证态」暴露它们。
  act(() => {
    const select = renderer.root.findAll(
      (node) =>
        typeof node.props?.onChange === 'function' && Array.isArray(node.props?.options)
    );
    select[0].props.onChange('all');
  });
  return renderer;
};

const authBadge = (renderer: ReactTestRenderer, name: string): ReactTestInstance =>
  renderer.root.find(
    (node) =>
      typeof node.type === 'string' &&
      node.props?.['data-testid'] === `farm-account-health-pill-${name}`
  );

const authReasonNodes = (renderer: ReactTestRenderer, name: string): ReactTestInstance[] =>
  renderer.root.findAll(
    (node) => node.props?.['data-testid'] === `farm-account-auth-reason-${name}`
  );

describe('FarmAccountsPanel · 无法确认存活显灰不显绿（F1/F2）', () => {
  it('token 陈旧（health_reason=account_token_stale）→ 账号卡显灰(idle)+告警，不显绿', () => {
    const renderer = renderPanel();
    const badge = authBadge(renderer, 'acct-stale');
    // 灰：idle 语义色；绝不是 healthy（绿 = ok）。data-status 是 FarmHealthVariant
    // （ok/warn/err/idle），绿=ok、灰=idle。
    expect(badge.props['data-auth-state']).toBe('liveness_unconfirmed');
    expect(badge.props['data-status']).toBe('idle');
    expect(badge.props['data-status']).not.toBe('ok');
    expect(badge.props['data-auth-state']).not.toBe('healthy');
    // 告警：reason 子行存在，且承载「最后确认存活」文案（title 也带该提示）。
    const reasons = authReasonNodes(renderer, 'acct-stale');
    expect(reasons).toHaveLength(1);
    expect(reasons[0].props['data-auth-state']).toBe('liveness_unconfirmed');
    expect(String(badge.props.title)).toContain('最后确认存活');
  });

  it('health-blind（账号 farm_health_blind=true）→ 账号卡显灰(idle)+告警，不显绿', () => {
    const renderer = renderPanel();
    const badge = authBadge(renderer, 'acct-blind');
    expect(badge.props['data-auth-state']).toBe('liveness_unconfirmed');
    expect(badge.props['data-status']).toBe('idle');
    expect(badge.props['data-status']).not.toBe('ok');
    expect(authReasonNodes(renderer, 'acct-blind')).toHaveLength(1);
  });

  it('对照：真正健康号仍显绿(healthy/success)，灰是特指、无误伤', () => {
    const renderer = renderPanel();
    const badge = authBadge(renderer, 'acct-ok');
    expect(badge.props['data-auth-state']).toBe('healthy');
    // 绿 = ok（healthy 的 FarmHealthVariant），与灰态 idle 明确区分。
    expect(badge.props['data-status']).toBe('ok');
    // 健康号不渲染 auth reason 子行（healthy 无副行告警）。
    expect(authReasonNodes(renderer, 'acct-ok')).toHaveLength(0);
  });
});
