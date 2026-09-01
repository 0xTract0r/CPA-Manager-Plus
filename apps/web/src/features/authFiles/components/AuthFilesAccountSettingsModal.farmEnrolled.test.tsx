import { act, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { AuthFilesAccountSettingsModal } from './AuthFilesAccountSettingsModal';
import type { AccountSettingsEditorState } from '@/features/authFiles/hooks/useAuthFilesAccountSettings';

// 农场纳管（farm_enrolled）是 Claude 专属能力。本测试锁定账号设置弹窗只对
// provider=claude 账号渲染 farm-enrolled 卡片，codex 等非 Claude 账号不渲染
// （回归覆盖：修复前该卡片对所有 provider 无条件渲染）。

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && typeof options.defaultValue === 'string' ? (options.defaultValue as string) : key,
  }),
}));

vi.mock('@/stores', () => ({
  useThemeStore: (selector: (state: unknown) => unknown) => selector({ resolvedTheme: 'light' }),
  useNotificationStore: (selector: (state: unknown) => unknown) =>
    selector({ showConfirmation: vi.fn() }),
}));

// Modal 用 portal，测试环境无 DOM——透传 children/footer 即可。
vi.mock('@/components/ui/Modal', () => ({
  Modal: (props: { children: ReactNode; footer?: ReactNode }) => (
    <div>
      <div>{props.children}</div>
      <div>{props.footer}</div>
    </div>
  ),
}));

// CodeMirror / JsonView 需要真实 DOM，且与本测试无关，桩掉。
vi.mock('@uiw/react-codemirror', () => ({ default: () => null }));
vi.mock('react-json-view-lite', () => ({
  JsonView: () => null,
  defaultStyles: {},
  darkStyles: {},
}));

// AccountFastImpactPanel 会拉取 analytics（codex 分支才挂载），与本测试无关，桩掉。
vi.mock('./AccountFastImpactPanel', () => ({
  AccountFastImpactPanel: () => null,
}));

// 身份变更审计历史面板（reauth / status）依赖 Drawer / portal / API，与本测试无关，桩掉。
vi.mock('./AuthFilesReauthHistoryPanel', () => ({
  AuthFilesReauthHistoryPanel: () => null,
}));
vi.mock('./AuthFilesStatusHistoryPanel', () => ({
  AuthFilesStatusHistoryPanel: () => null,
}));

const makeEditor = (provider: string): AccountSettingsEditorState => ({
  fileName: `acct-${provider}.json`,
  file: { name: `acct-${provider}.json`, type: provider } as AccountSettingsEditorState['file'],
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

describe('AuthFilesAccountSettingsModal farm enrollment gate', () => {
  it('renders the farm-enrolled card for claude accounts', () => {
    const renderer = mountModal(makeEditor('claude'));
    expect(countByTestId(renderer, 'account-settings-farm-enrolled-card')).toBe(1);
    // codex 专属的 fast 卡片不应对 claude 渲染（反向 sanity）。
    expect(countByTestId(renderer, 'account-settings-fast-card')).toBe(0);
    renderer.unmount();
  });

  it('does not render the farm-enrolled card for codex (non-claude) accounts', () => {
    const renderer = mountModal(makeEditor('codex'));
    expect(countByTestId(renderer, 'account-settings-farm-enrolled-card')).toBe(0);
    // codex 仍应看到自己的 fast 卡片：证明 gate 是 provider 专属而非「全隐藏」。
    expect(countByTestId(renderer, 'account-settings-fast-card')).toBe(1);
    renderer.unmount();
  });
});
