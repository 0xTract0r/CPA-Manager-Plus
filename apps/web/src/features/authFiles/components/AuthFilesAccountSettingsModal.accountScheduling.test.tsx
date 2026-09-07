import { act, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { AuthFilesAccountSettingsModal } from './AuthFilesAccountSettingsModal';
import type { AccountSettingsEditorState } from '@/features/authFiles/hooks/useAuthFilesAccountSettings';

// 调度旋钮（tier_override / rate_scale）面板是 Claude 专属能力（同 farm_enrolled
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

// AccountSchedulingPanel 自身的接线/请求参数已在 AccountSchedulingPanel.test.tsx
// 独立覆盖；这里只需要一个可探测的占位，用来断言 provider gate。
vi.mock('./AccountSchedulingPanel', () => ({
  AccountSchedulingPanel: (props: { fileName: string }) => (
    <div data-testid="account-settings-scheduling-panel-stub">{props.fileName}</div>
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

const mountModal = (editor: AccountSettingsEditorState): ReactTestRenderer => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <AuthFilesAccountSettingsModal
        disableControls={false}
        editor={editor}
        updatedText="{}"
        dirty={false}
        onClose={() => {}}
        onCopyText={() => {}}
        onSave={() => {}}
        onChange={() => {}}
      />
    );
  });
  return renderer;
};

const countByTestId = (renderer: ReactTestRenderer, testId: string): number =>
  renderer.root.findAllByProps({ 'data-testid': testId }).length;

describe('AuthFilesAccountSettingsModal scheduling-panel provider gate', () => {
  it('renders the scheduling panel for claude accounts', () => {
    const renderer = mountModal(makeEditor('claude'));
    expect(countByTestId(renderer, 'account-settings-scheduling-panel-stub')).toBe(1);
    renderer.unmount();
  });

  it('does not render the scheduling panel for codex (non-claude) accounts', () => {
    const renderer = mountModal(makeEditor('codex'));
    expect(countByTestId(renderer, 'account-settings-scheduling-panel-stub')).toBe(0);
    // codex 仍应看到自己的 fast 卡片（gate 是 provider 专属而非把整个 toggleGrid 隐藏）。
    expect(countByTestId(renderer, 'account-settings-fast-card')).toBe(1);
    renderer.unmount();
  });
});
