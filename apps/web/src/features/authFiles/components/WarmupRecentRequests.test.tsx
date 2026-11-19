import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { WarmupRequestStatus } from './WarmupRecentRequests';
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string) => (key.endsWith('request_success') ? '成功' : '失败'),
  }),
}));
describe('recent request HTTP status evidence', () => {
  it.each([undefined, null, 0])(
    'does not invent HTTP 200 for success without a valid code (%s)',
    (code) => {
      let view!: ReactTestRenderer;
      act(() => {
        view = create(<WarmupRequestStatus row={{ failed: false, fail_status_code: code }} />);
      });
      expect(view.toJSON()).toBe('成功');
    }
  );
  it.each([
    [false, 200],
    [true, 403],
  ] as const)('shows an explicit supplied status code', (failed, code) => {
    let view!: ReactTestRenderer;
    act(() => {
      view = create(<WarmupRequestStatus row={{ failed, fail_status_code: code }} />);
    });
    expect(JSON.stringify(view.toJSON())).toContain(` · ${code}`);
  });
});
