import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { AuthFileItem } from '@/types';
import { AuthFileCard, type AuthFileCardProps } from './AuthFileCard';

// P7（account-session-count-display）：账号卡消费 core account_scheduling 投影
// （会话计数 + 细粒度订阅等级）的渲染回归。用 fixture 数据（非真实网络请求）
// 覆盖：有数据/空数据(sessions_total===0)/数据源缺失三种真实场景，锁定「暂无
// 会话数据」不能被数字 0 顶替、「未知」档位必须显式展示。

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (options && typeof options.defaultValue === 'string') {
        return Object.entries(options).reduce(
          (acc, [optionKey, optionValue]) =>
            optionKey === 'defaultValue'
              ? acc
              : acc.split(`{{${optionKey}}}`).join(String(optionValue)),
          options.defaultValue as string
        );
      }
      return key;
    },
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}));

const baseProps: Omit<AuthFileCardProps, 'file'> = {
  compact: true,
  selected: false,
  resolvedTheme: 'light',
  disableControls: false,
  deleting: null,
  statusUpdating: {},
  statusRefreshing: {},
  statusBarCache: new Map(),
  onShowModels: () => {},
  onDownload: () => {},
  onOpenAccountSettings: () => {},
  onDelete: () => {},
  onToggleStatus: () => {},
  onToggleSelect: () => {},
};

function renderJson(file: AuthFileItem, overrides: Partial<AuthFileCardProps> = {}): string {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<AuthFileCard {...baseProps} {...overrides} file={file} />);
  });
  return JSON.stringify(renderer.toJSON());
}

describe('AuthFileCard: P7 session summary + subscription tier badge', () => {
  it('renders real session counts and the known max_20x tier inside the merged plan row (Q8: no top badge)', () => {
    const file: AuthFileItem = {
      name: 'claude-acct-1.json',
      type: 'claude',
      disabled: false,
      account_scheduling: {
        subscription_tier: 'max_20x',
        sessions_total: 12,
        sessions_active: 5,
        sessions_closed: 7,
      },
    };
    const json = renderJson(file);
    expect(json).toContain('Max 20x');
    expect(json).toContain('Sessions');
    expect(json).not.toContain('No session data yet');
    expect(json).not.toContain('Session data unavailable');

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AuthFileCard {...baseProps} file={file} />);
    });
    // Q8: exactly one tier element (the old top independent badge is gone; the tier
    // is now shown only once, in the merged plan/套餐 row).
    const badges = renderer.root.findAllByProps({
      'data-testid': `auth-file-tier-badge-${file.name}`,
    });
    expect(badges).toHaveLength(1);
    expect(badges[0].props['data-tier']).toBe('max_20x');
    // The tier value must live inside the claude plan row (insights area), not the
    // header badge row — proves the relocation rather than a coincidental single match.
    const tierRow = renderer.root.findByProps({
      'data-testid': `auth-file-claude-tier-row-${file.name}`,
    });
    expect(
      tierRow.findByProps({ 'data-testid': `auth-file-tier-badge-${file.name}` }).props['data-tier']
    ).toBe('max_20x');
    // auto tier (no tier_source override) must NOT render the manual marker.
    expect(
      renderer.root.findAllByProps({ 'data-testid': `auth-file-tier-override-${file.name}` })
    ).toHaveLength(0);
    // Q9: session summary is wrapped so it is grouped/separated from the health panel.
    const summary = renderer.root.findByProps({ 'data-testid': 'account-session-summary' });
    expect(summary.props['data-account-session-status']).toBe('ok');
  });

  it('Q10: marks tier_source="override" accounts with a manual marker; auto accounts get none', () => {
    const overrideFile: AuthFileItem = {
      name: 'claude-override.json',
      type: 'claude',
      disabled: false,
      account_scheduling: {
        subscription_tier: 'max_5x',
        tier_source: 'override',
        sessions_total: 4,
        sessions_active: 2,
        sessions_closed: 2,
      },
    };
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AuthFileCard {...baseProps} file={overrideFile} />);
    });
    expect(
      renderer.root.findAllByProps({ 'data-testid': `auth-file-tier-override-${overrideFile.name}` })
    ).toHaveLength(1);
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('Manual');
    expect(json).toContain('Max 5x');

    const autoFile: AuthFileItem = {
      ...overrideFile,
      name: 'claude-auto.json',
      account_scheduling: {
        subscription_tier: 'max_5x',
        tier_source: 'auto',
        sessions_total: 4,
        sessions_active: 2,
        sessions_closed: 2,
      },
    };
    let autoRenderer!: ReactTestRenderer;
    act(() => {
      autoRenderer = create(<AuthFileCard {...baseProps} file={autoFile} />);
    });
    expect(
      autoRenderer.root.findAllByProps({ 'data-testid': `auth-file-tier-override-${autoFile.name}` })
    ).toHaveLength(0);
  });

  it('Q5: labels warming-up accounts (warmup.mature===false) and leaves mature ones unlabeled', () => {
    const warmingFile: AuthFileItem = {
      name: 'claude-warming.json',
      type: 'claude',
      disabled: false,
      account_scheduling: {
        subscription_tier: 'pro',
        sessions_total: 1,
        sessions_active: 1,
        sessions_closed: 0,
        warmup: { stage: 'cold', mature: false, age_days: 2 },
      },
    };
    let warmingRenderer!: ReactTestRenderer;
    act(() => {
      warmingRenderer = create(<AuthFileCard {...baseProps} file={warmingFile} />);
    });
    const warmupBadge = warmingRenderer.root.findByProps({
      'data-testid': `auth-file-warmup-badge-${warmingFile.name}`,
    });
    expect(warmupBadge.props['data-warmup-stage']).toBe('cold');
    expect(JSON.stringify(warmingRenderer.toJSON())).toContain('Warming up');

    const matureFile: AuthFileItem = {
      ...warmingFile,
      name: 'claude-mature.json',
      account_scheduling: {
        subscription_tier: 'pro',
        sessions_total: 1,
        sessions_active: 1,
        sessions_closed: 0,
        warmup: { stage: 'mature', mature: true, age_days: 120 },
      },
    };
    let matureRenderer!: ReactTestRenderer;
    act(() => {
      matureRenderer = create(<AuthFileCard {...baseProps} file={matureFile} />);
    });
    expect(
      matureRenderer.root.findAllByProps({
        'data-testid': `auth-file-warmup-badge-${matureFile.name}`,
      })
    ).toHaveLength(0);
    expect(JSON.stringify(matureRenderer.toJSON())).not.toContain('Warming up');
  });

  it('renders the explicit "unknown" tier badge instead of guessing when core reports an unrecognized value', () => {
    const file: AuthFileItem = {
      name: 'claude-acct-2.json',
      type: 'claude',
      disabled: false,
      account_scheduling: {
        subscription_tier: 'default_claude_ai', // 上游未映射值，core 侧已折成 "unknown"
        sessions_total: 2,
        sessions_active: 1,
        sessions_closed: 1,
      },
    };
    const json = renderJson(file);
    expect(json).toContain('Unknown');
    expect(json).not.toContain('Max 20x');
    expect(json).not.toContain('Max 5x');
  });

  it('shows "暂无会话数据" (not a raw 0) when sessions_total is exactly 0 — the empty-state fixture', () => {
    const file: AuthFileItem = {
      name: 'claude-acct-3.json',
      type: 'claude',
      disabled: false,
      account_scheduling: {
        subscription_tier: 'pro',
        sessions_total: 0,
        sessions_active: 0,
        sessions_closed: 0,
      },
    };
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AuthFileCard {...baseProps} file={file} />);
    });
    const summary = renderer.root.findByProps({ 'data-testid': 'account-session-summary' });
    expect(summary.props['data-account-session-status']).toBe('empty');
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('No session data yet');
  });

  it('shows the unavailable state and no tier badge when account_scheduling is entirely absent (older core / version skew)', () => {
    const file: AuthFileItem = {
      name: 'claude-acct-4.json',
      type: 'claude',
      disabled: false,
      // account_scheduling intentionally omitted — simulates a core deployment
      // that predates this projection (real, documented failure mode in this repo).
    };
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AuthFileCard {...baseProps} file={file} />);
    });
    const summary = renderer.root.findByProps({ 'data-testid': 'account-session-summary' });
    expect(summary.props['data-account-session-status']).toBe('unavailable');
    expect(
      renderer.root.findAllByProps({ 'data-testid': `auth-file-tier-badge-${file.name}` })
    ).toHaveLength(0);
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('Session data unavailable');
  });

  it('shows the "counting" loading state while this account is mid status-refresh', () => {
    const file: AuthFileItem = {
      name: 'claude-acct-5.json',
      type: 'claude',
      disabled: false,
      account_scheduling: {
        subscription_tier: 'pro',
        sessions_total: 9,
        sessions_active: 4,
        sessions_closed: 5,
      },
    };
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <AuthFileCard {...baseProps} file={file} statusRefreshing={{ [file.name]: true }} />
      );
    });
    const summary = renderer.root.findByProps({ 'data-testid': 'account-session-summary' });
    expect(summary.props['data-account-session-status']).toBe('loading');
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('Counting');
    // Stale counts must not still render as testid'd stat items while a refresh for
    // this exact account is in flight (precise element check, not a fragile substring
    // match — an unrelated icon's svg attribute could coincidentally contain "9").
    expect(renderer.root.findAllByProps({ 'data-testid': 'account-session-total' })).toHaveLength(0);
  });

  it('does not render a tier badge for a non-claude/non-codex provider even with account_scheduling present', () => {
    const file: AuthFileItem = {
      name: 'qwen-acct-1.json',
      type: 'qwen',
      disabled: false,
      account_scheduling: {
        subscription_tier: 'unknown',
        sessions_total: 3,
        sessions_active: 1,
        sessions_closed: 2,
      },
    };
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AuthFileCard {...baseProps} file={file} />);
    });
    expect(
      renderer.root.findAllByProps({ 'data-testid': `auth-file-tier-badge-${file.name}` })
    ).toHaveLength(0);
    // Session summary is still generic/provider-agnostic and should render.
    const summary = renderer.root.findByProps({ 'data-testid': 'account-session-summary' });
    expect(summary.props['data-account-session-status']).toBe('ok');
  });
});
