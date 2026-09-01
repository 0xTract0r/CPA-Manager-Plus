import { act, type ReactNode } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AuthFilesAccountSettingsModal } from './AuthFilesAccountSettingsModal';
import { Button } from '@/components/ui/Button';
import { farmApi } from '@/services/api/farm';
import type { AccountSettingsEditorState } from '@/features/authFiles/hooks/useAuthFilesAccountSettings';
import type { FarmRotateProxyResponse } from '@/types/farm';

// §2（farm-proxy-rotation）换代理二次确认门禁回归覆盖：
//  - 硬 gate 只认 isClaudeProvider && farmBound===true（不是 isClaudeManagedPolicy）
//    ——codex 与「非农场」Claude 账号改 proxy_url 保存都不应弹换代理确认，直接
//    走原有 onSave()，不触发任何容器动作。
//  - 只有已纳入农场的 Claude 账号且本次保存*实际改动了* proxy_url 时才弹二次
//    确认；确认后调 farmApi.rotateProxy(..., confirm:true)，成功才继续
//    onSave()，失败则不 onSave()（避免 CPA 侧 proxy_url 与农场容器实际出口
//    不一致）。

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && typeof options.defaultValue === 'string' ? (options.defaultValue as string) : key,
  }),
}));

const mockShowConfirmation = vi.fn();
const notificationState = {
  showConfirmation: mockShowConfirmation,
  showNotification: vi.fn(),
};

// 真实 store 既支持 `useNotificationStore(selector)`（Modal 里用来只取
// showConfirmation），也支持 `useNotificationStore()` 不带 selector 拿整个
// state（useFarmRotateProxy 内部用法）——桩要同时兼容两种调用姿势。
vi.mock('@/stores', () => ({
  useThemeStore: (selector: (state: unknown) => unknown) => selector({ resolvedTheme: 'light' }),
  useNotificationStore: (selector?: (state: typeof notificationState) => unknown) =>
    selector ? selector(notificationState) : notificationState,
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

// 身份变更审计历史面板依赖 Drawer / portal / API，与本测试无关，桩掉。
vi.mock('./AuthFilesReauthHistoryPanel', () => ({
  AuthFilesReauthHistoryPanel: () => null,
}));
vi.mock('./AuthFilesStatusHistoryPanel', () => ({
  AuthFilesStatusHistoryPanel: () => null,
}));

// farmApi 只桩 rotateProxy（useFarmRotateProxy 唯一用到的方法），网络边界处切断，
// 让真实 useFarmRotateProxy hook 逻辑（confirm:true 强制写死 / businessCode 分支 /
// rotating 状态）照常跑。
vi.mock('@/services/api/farm', () => ({
  farmApi: {
    rotateProxy: vi.fn(),
  },
}));

const ORIGINAL_PROXY_URL = 'socks5://user:pass@host:1080';
const NEXT_PROXY_URL = 'socks5://user:pass@host2:1080';

const makeEditor = (
  overrides: Partial<AccountSettingsEditorState> & { provider: string }
): AccountSettingsEditorState => ({
  fileName: `acct-${overrides.provider}.json`,
  file: { name: `acct-${overrides.provider}.json`, type: overrides.provider } as AccountSettingsEditorState['file'],
  authIndex: 1,
  providerKey: overrides.provider,
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
  proxyUrl: ORIGINAL_PROXY_URL,
  proxyUrlBaseline: ORIGINAL_PROXY_URL,
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
  originalSerializedRequest: JSON.stringify({ proxy_url: ORIGINAL_PROXY_URL }),
  ...overrides,
});

const mountModal = (
  editor: AccountSettingsEditorState,
  onSave: () => void
): ReactTestRenderer => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <AuthFilesAccountSettingsModal
        disableControls={false}
        editor={editor}
        updatedText="{}"
        dirty
        onClose={() => {}}
        onCopyText={() => {}}
        onSave={onSave}
        onChange={() => {}}
      />
    );
  });
  return renderer;
};

const clickSave = (renderer: ReactTestRenderer) => {
  const saveButton = renderer.root
    .findAllByType(Button)
    .find((instance) => instance.props.children === 'common.save');
  if (!saveButton || typeof saveButton.props.onClick !== 'function') {
    throw new Error('Save button not found');
  }
  act(() => {
    saveButton.props.onClick();
  });
};

const rotateProxyMock = vi.mocked(farmApi.rotateProxy);

describe('AuthFilesAccountSettingsModal §2 换代理二次确认门禁', () => {
  beforeEach(() => {
    mockShowConfirmation.mockReset();
    rotateProxyMock.mockReset();
  });

  it('codex 账号改 proxy_url 保存：不弹换代理确认，直接 onSave()', () => {
    const onSave = vi.fn();
    const editor = makeEditor({
      provider: 'codex',
      farmBound: true, // 即使 farmBound 恰好为 true，codex 也必须被 isClaudeProvider 排除
      proxyUrl: NEXT_PROXY_URL,
    });
    const renderer = mountModal(editor, onSave);
    clickSave(renderer);

    expect(mockShowConfirmation).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(rotateProxyMock).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('非农场 Claude 账号（farmBound 非 true）改 proxy_url 保存：不弹换代理确认，直接 onSave()', () => {
    const onSave = vi.fn();
    const editor = makeEditor({
      provider: 'claude',
      farmBound: false,
      proxyUrl: NEXT_PROXY_URL,
    });
    const renderer = mountModal(editor, onSave);
    clickSave(renderer);

    expect(mockShowConfirmation).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(rotateProxyMock).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('农场 Claude 账号但本次没改 proxy_url（只是保存其它字段）：不弹换代理确认，直接 onSave()', () => {
    const onSave = vi.fn();
    const editor = makeEditor({
      provider: 'claude',
      farmBound: true,
      proxyUrl: ORIGINAL_PROXY_URL, // 与 originalSerializedRequest 基线相同 = 未改动
      note: 'operator note changed',
    });
    const renderer = mountModal(editor, onSave);
    clickSave(renderer);

    expect(mockShowConfirmation).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(rotateProxyMock).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('农场 Claude 账号改了 proxy_url：弹换代理确认，确认后调 rotateProxy(confirm:true) 成功才 onSave()', async () => {
    const onSave = vi.fn();
    const editor = makeEditor({
      provider: 'claude',
      farmBound: true,
      proxyUrl: NEXT_PROXY_URL,
    });
    const successResponse: FarmRotateProxyResponse = {
      account: editor.fileName,
      env: 'test',
      old_container_id: 'ctr-old',
      new_container_id: 'ctr-new',
      new_device_id_masked: 'abcd********wxyz',
      reason: 'manual_rotation',
      superseded: true,
    };
    rotateProxyMock.mockResolvedValueOnce(successResponse);

    const renderer = mountModal(editor, onSave);
    clickSave(renderer);

    // 保存被拦截：确认弹窗已触发，但 onSave() 还不能立即执行（要等轮换先成功）。
    expect(mockShowConfirmation).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();

    const options = mockShowConfirmation.mock.calls[0][0] as { onConfirm: () => Promise<void> };
    await act(async () => {
      await options.onConfirm();
    });

    expect(rotateProxyMock).toHaveBeenCalledTimes(1);
    expect(rotateProxyMock).toHaveBeenCalledWith({
      account_id: editor.fileName,
      env: 'test',
      proxy_url: NEXT_PROXY_URL,
      confirm: true,
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('农场 Claude 账号改了 proxy_url 但轮换失败：不调 onSave()（fail-closed）', async () => {
    const onSave = vi.fn();
    const editor = makeEditor({
      provider: 'claude',
      farmBound: true,
      proxyUrl: NEXT_PROXY_URL,
    });
    rotateProxyMock.mockRejectedValueOnce(new Error('rotate failed'));

    const renderer = mountModal(editor, onSave);
    clickSave(renderer);

    const options = mockShowConfirmation.mock.calls[0][0] as { onConfirm: () => Promise<void> };
    await act(async () => {
      await options.onConfirm();
    });

    expect(rotateProxyMock).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    renderer.unmount();
  });
});
