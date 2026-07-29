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
  onOpenPrefixProxyEditor: () => {},
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
});
