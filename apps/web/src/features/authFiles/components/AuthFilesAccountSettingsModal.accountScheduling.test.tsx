import { act, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthFilesAccountSettingsModal,
  type AuthFilesAccountSettingsModalProps,
} from './AuthFilesAccountSettingsModal';
import { Modal } from '@/components/ui/Modal';
import type { AccountSettingsEditorState } from '@/features/authFiles/hooks/useAuthFilesAccountSettings';

// 调度入口是 Claude 专属能力（同 farm_enrolled
// 的 provider gate 模式，见 AuthFilesAccountSettingsModal.farmEnrolled.test.tsx）。
// 本测试只锁定「只对 provider=claude 渲染」这条 gate，控件本身的交互/请求参数/
// 返回投影刷新在 AccountSchedulingPanel.test.tsx 和
// useAccountSchedulingControls.test.ts 里覆盖。

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && typeof options.defaultValue === 'string' ? (options.defaultValue as string) : key,
  }),
}));

// useNotificationStore 既被本弹窗以 selector 形式调用（`useNotificationStore(s =>
// s.showConfirmation)`），也被 useFarmRotateProxy 以无参形式调用（`useNotificationStore()`
// 取整个 store，真实 zustand 两种调用都支持）——mock 必须两种都接住，否则会撞上
// 既有 farmEnrolled 测试里那个「selector is not a function」的基线红（同一根因，
// 与本次改动无关，见交付说明）。
vi.mock('@/stores', () => ({
  useThemeStore: (selector: (state: unknown) => unknown) => selector({ resolvedTheme: 'light' }),
  useNotificationStore: (selector?: (state: unknown) => unknown) => {
    const state = { showConfirmation: vi.fn(), showNotification: vi.fn() };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: (props: { children: ReactNode; footer?: ReactNode }) => (
    <div>
      <div>{props.children}</div>
      <div>{props.footer}</div>
    </div>
  ),
}));

vi.mock('@uiw/react-codemirror', () => ({ default: () => null }));
vi.mock('react-json-view-lite', () => ({
  JsonView: () => null,
  defaultStyles: {},
  darkStyles: {},
}));

vi.mock('./AccountFastImpactPanel', () => ({
  AccountFastImpactPanel: () => null,
}));
vi.mock('./AuthFilesReauthHistoryPanel', () => ({
  AuthFilesReauthHistoryPanel: () => null,
}));
vi.mock('./AuthFilesStatusHistoryPanel', () => ({
  AuthFilesStatusHistoryPanel: () => null,
}));

// 基础设置只保留摘要和跳转；实际编辑器在独立窗口中。
vi.mock('./AccountWarmupSummary', () => ({
  AccountWarmupSummary: ({ action }: { action?: ReactNode }) => (
    <div data-testid="account-scheduling-summary">{action}</div>
  ),
}));

const makeEditor = (provider: string): AccountSettingsEditorState => ({
  fileName: `acct-${provider}.json`,
  file: {
    name: `acct-${provider}.json`,
    type: provider,
    account_scheduling: { subscription_tier: 'max_5x', tier_source: 'auto', rate_scale: 1 },
  } as AccountSettingsEditorState['file'],
  authIndex: 1,
  provider,
  providerKey: provider,
  fileInfoText: '{}',
  prefix: '',
  priority: '',
  websockets: false,
  rawJsonAvailable: false,
  rawJsonObject: null,
  rawJsonText: '',
  rawJsonBaseline: '',
  rawJsonTouched: false,
  rawJsonError: null,
  loading: false,
  saving: false,
  error: null,
  proxyUrl: 'socks5://user:pass@host:1080',
  proxyUrlBaseline: 'socks5://user:pass@host:1080',
  proxyUrlError: null,
  note: '',
  disabled: false,
  refreshEnabled: true,
  fast: false,
  farmEnrolled: false,
  managedHeaders: {},
  managedHeaderState: null,
  syntheticDeviceId: '',
  farmBound: undefined,
  deviceIdSource: undefined,
  clientVersionObservations: [],
  runtimeProfileText: '',
  runtimeIdentityText: '',
  warnings: [],
  extraHeadersText: '{}',
  extraHeadersTouched: false,
  extraHeadersError: null,
  transportProfileText: '',
  transportProfileTouched: false,
  transportProfileError: null,
  tlsProfileText: '',
  tlsProfileTouched: false,
  tlsProfileError: null,
  originalSerializedRequest: '{}',
});

const mountModal = (
  editor: AccountSettingsEditorState,
  onOpenLimits?: () => void,
  dirty = false
): ReactTestRenderer => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <AuthFilesAccountSettingsModal
        disableControls={false}
        editor={editor}
        updatedText="{}"
        dirty={dirty}
        onClose={() => {}}
        onCopyText={() => {}}
        onSave={() => {}}
        onChange={() => {}}
        onOpenLimits={onOpenLimits}
      />
    );
  });
  return renderer;
};

const countByTestId = (renderer: ReactTestRenderer, testId: string): number =>
  renderer.root.findAllByProps({ 'data-testid': testId }).length;

describe('基础设置的紧凑调度入口', () => {
  it('轮询换父回调时保持Modal关闭回调稳定，调用最新父回调', () => {
    const renderer = mountModal(makeEditor('claude'));
    const close = renderer.root.findByType(Modal).props.onClose;
    const latestClose = vi.fn();
    const props = renderer.root.findByType(AuthFilesAccountSettingsModal)
      .props as AuthFilesAccountSettingsModalProps;
    act(() => renderer.update(<AuthFilesAccountSettingsModal {...props} onClose={latestClose} />));
    expect(renderer.root.findByType(Modal).props.onClose).toBe(close);
    act(() => close());
    expect(latestClose).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });
  it('Claude仅有摘要，没有完整策略或进度面板', () => {
    const renderer = mountModal(makeEditor('claude'), vi.fn());
    expect(countByTestId(renderer, 'account-scheduling-summary')).toBe(1);
    expect(countByTestId(renderer, 'account-limit-policy')).toBe(0);
    expect(countByTestId(renderer, 'warmup-policy-summary')).toBe(0);
    act(() => renderer.unmount());
  });

  it('非Claude没有调度入口，Codex fast保留', () => {
    const renderer = mountModal(makeEditor('codex'));
    expect(countByTestId(renderer, 'account-scheduling-summary')).toBe(0);
    expect(countByTestId(renderer, 'account-settings-fast-card')).toBe(1);
    act(() => renderer.unmount());
  });

  it('干净的基础设置可进入独立调度窗口', () => {
    const onOpenLimits = vi.fn();
    const renderer = mountModal(makeEditor('claude'), onOpenLimits);
    const button = renderer.root
      .findAllByType('button')
      .find((node) => node.props['data-testid'] === 'account-settings-open-limits')!;
    expect(button.props.disabled).toBe(false);
    act(() => button.props.onClick());
    expect(onOpenLimits).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });

  it('未保存或缺少接线时禁用跳转，避免悄悄丢修改', () => {
    for (const [handler, dirty] of [
      [vi.fn(), true],
      [undefined, false],
    ] as const) {
      const renderer = mountModal(makeEditor('claude'), handler, dirty);
      const button = renderer.root
        .findAllByType('button')
        .find((node) => node.props['data-testid'] === 'account-settings-open-limits')!;
      expect(button.props.disabled).toBe(true);
      act(() => renderer.unmount());
    }
  });
});
