import { create, act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { AuthFileItem } from '@/types';
import { AuthFileCard, type AuthFileCardProps } from './AuthFileCard';

// core payload 已带 auto_quarantined/quarantine_reason/quarantined_at，本测试锁定
// AuthFileCard 徽标必须优先信这个布尔，而不是继续显示假绿（回归覆盖本次修复）。

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
  }),
}));

const baseProps: Omit<AuthFileCardProps, 'file'> = {
  compact: true,
  selected: false,
  resolvedTheme: 'light',
  disableControls: false,
  deleting: null,
  statusUpdating: {},
  statusBarCache: new Map(),
  onShowModels: () => {},
  onDownload: () => {},
  onOpenAccountSettings: () => {},
  onDelete: () => {},
  onToggleStatus: () => {},
  onToggleSelect: () => {},
};

// provider 选用 qwen：既不在 OAUTH_AUDITABLE_PROVIDER_KEYS 也不在
// QUOTA_PROVIDER_TYPES，避免拉起审计面板 / 配额区块，聚焦徽标本身。
const healthyFile: AuthFileItem = {
  name: 'qwen-acct-1.json',
  type: 'qwen',
  disabled: false,
};

const quarantinedFile: AuthFileItem = {
  ...healthyFile,
  name: 'qwen-acct-2.json',
  status_message: 'ok', // 故意保留一个"看起来健康"的旧文案，验证隔离判定优先级更高
  auto_quarantined: true,
  quarantine_reason: 'terminal_auth_failure',
  quarantined_at: '2026-07-01T00:00:00Z',
};

// 需重新认证账号（纵深防御）：未被隔离、显式 unavailable=false、status_message 健康，
// 但带 reauth_url —— 徽标必须显示「需重新认证」而不是绿色启用态。
const reauthRequiredFile: AuthFileItem = {
  ...healthyFile,
  name: 'qwen-acct-reauth.json',
  status_message: 'ok',
  unavailable: false,
  reauth_url: 'https://claude.ai/oauth/reauthorize?x=1',
};

function findByText(root: ReactTestInstance, text: string): ReactTestInstance[] {
  return root.findAll(
    (node) => typeof node.type === 'string' && node.children.some((child) => child === text)
  );
}

describe('AuthFileCard auto_quarantined badge', () => {
  it('shows a healthy-looking badge for a normal, non-quarantined account', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AuthFileCard {...baseProps} file={healthyFile} />);
    });

    const root = renderer.root;
    // 健康账号不应出现"已隔离"字样
    expect(findByText(root, 'auth_files.health_status_quarantined')).toHaveLength(0);
  });

  it('renders "已隔离" (quarantined) badge, not a healthy green badge, when auto_quarantined=true', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AuthFileCard {...baseProps} file={quarantinedFile} />);
    });

    const root = renderer.root;

    // 徽标必须显示隔离态标签（本测试的 t() mock 对 defaultValue 做原样返回）。
    const quarantineBadge = findByText(root, 'Quarantined');
    expect(quarantineBadge.length).toBeGreaterThan(0);

    // 不应该退化显示为旧的健康态文案（假绿场景）——注意 status_toggle_label
    // 同时也是卡片底部启用开关的固定标签文案，与状态徽标无关，不能用来断言。
    expect(findByText(root, 'auth_files.health_status_healthy')).toHaveLength(0);

    // tooltip 应带上 reason + at 占位信息，而不是空字符串。
    const badgeSpan = quarantineBadge[0];
    expect(String(badgeSpan.props.title || '')).toContain('terminal_auth_failure');
  });

  // Path B（开关回归可点，2026-07-31 反转后行为）：开关只反映 file.disabled
  // 本身的 operator 意图，不再因 isAutoQuarantined 被强制显示为「关」或只读；
  // 隔离状态改由上方徽标（quarantineBadgeTitle）独立呈现，两者解耦。
  it('reflects disabled intent (checked, since disabled=false) and stays interactive for a quarantined account; quarantine is surfaced via the badge, not by making the toggle read-only', () => {
    let renderer!: ReactTestRenderer;
    const onToggleStatus = vi.fn();
    act(() => {
      renderer = create(
        <AuthFileCard {...baseProps} file={quarantinedFile} onToggleStatus={onToggleStatus} />
      );
    });

    const toggleContainer = renderer.root.findByProps({
      'data-testid': `auth-file-status-toggle-${quarantinedFile.name}`,
    });
    const toggleInput = toggleContainer.findByType('input');

    // quarantinedFile.disabled === false ⇒ checked=true（!file.disabled），
    // 且不因隔离态被强制 disabled=true。
    expect(toggleInput.props.checked).toBe(true);
    expect(toggleInput.props.disabled).toBe(false);
  });

  it('shows the enabled toggle as ON and interactive for a healthy account', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AuthFileCard {...baseProps} file={healthyFile} />);
    });

    const toggleContainer = renderer.root.findByProps({
      'data-testid': `auth-file-status-toggle-${healthyFile.name}`,
    });
    const toggleInput = toggleContainer.findByType('input');

    expect(toggleInput.props.checked).toBe(true);
    expect(toggleInput.props.disabled).toBe(false);
  });

  it('shows a disabled (but not quarantined) account toggle as OFF yet still interactive', () => {
    let renderer!: ReactTestRenderer;
    const disabledFile: AuthFileItem = { ...healthyFile, name: 'qwen-acct-3.json', disabled: true };
    act(() => {
      renderer = create(<AuthFileCard {...baseProps} file={disabledFile} />);
    });

    const toggleContainer = renderer.root.findByProps({
      'data-testid': `auth-file-status-toggle-${disabledFile.name}`,
    });
    const toggleInput = toggleContainer.findByType('input');

    // 普通停用（非隔离）账号的开关可交互、当前显关；隔离态开关也已回退为可交互（反转 Path B），不再强制只读，隔离信息由徽标独立呈现。
    expect(toggleInput.props.checked).toBe(false);
    expect(toggleInput.props.disabled).toBe(false);
  });

  // 异常原因常驻可见 + 接线 recent_requests 的 Failed 计数（原因 + 失败次数两级）。
  it('renders the quarantine reason as always-visible text with the recent failure count wired in', () => {
    const quarantinedWithFailures: AuthFileItem = {
      ...quarantinedFile,
      name: 'qwen-acct-4.json',
      recent_requests: [
        { success: 1, failed: 2 },
        { success: 0, failed: 3 },
      ],
    };

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AuthFileCard {...baseProps} file={quarantinedWithFailures} />);
    });

    const root = renderer.root;

    // 原因文本必须以可见 <span> 呈现（不仅仅是 title 悬浮提示）；at 用
    // formatDateTime 本地化格式化，此处只锁 reason 关键字，不锁具体时间字符串。
    const noticeNode = root.findByProps({
      'data-testid': `auth-file-quarantine-notice-${quarantinedWithFailures.name}`,
    });
    const reasonTextSpan = noticeNode
      .findAll((node) => node.type === 'span')
      .find((node) => node.children.some((child) => String(child).includes('terminal_auth_failure')));
    expect(reasonTextSpan).toBeDefined();

    // 失败次数取自 recent_requests 的 Failed 字段汇总（2 + 3 = 5）。
    const failureCountNode = root.findByProps({
      'data-testid': `auth-file-recent-failure-count-${quarantinedWithFailures.name}`,
    });
    expect(failureCountNode.children.join('')).toContain('5');
  });
});

describe('AuthFileCard reauth-required badge (defense-in-depth)', () => {
  it('renders the "Re-authentication required" badge, not a healthy green badge, when reauth_url is present and unavailable=false', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AuthFileCard {...baseProps} file={reauthRequiredFile} />);
    });

    const root = renderer.root;

    // 状态徽标通过专用 testid 定位，文案走 t() mock 的 defaultValue 原样返回。
    const badge = root.findByProps({ 'data-testid': 'auth-file-reauth-required-badge' });
    expect(badge.children.join('')).toContain('Re-authentication required');

    // 绝不能退化成绿色健康态（假绿回归点）；也不应误判为隔离态。
    expect(findByText(root, 'auth_files.health_status_healthy')).toHaveLength(0);
    expect(findByText(root, 'Quarantined')).toHaveLength(0);
  });

  it('does not render the reauth-required badge for a healthy account without any reauth signal', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AuthFileCard {...baseProps} file={healthyFile} />);
    });

    expect(
      renderer.root.findAllByProps({ 'data-testid': 'auth-file-reauth-required-badge' })
    ).toHaveLength(0);
  });
});
