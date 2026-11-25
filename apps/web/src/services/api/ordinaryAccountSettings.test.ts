import { describe, it, expect, vi } from 'vitest';
const mock = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('./client', () => ({
  apiClient: mock,
  createScopedApiRequestConfig: (scope: unknown) => ({ captured: scope }),
}));
import {
  ordinaryAccountSettingsApi as api,
  flattenOrdinarySettings,
} from './ordinaryAccountSettings';
const target = { name: 'ordinary.json', authIndex: 'exact-a' };
const scope = {
  apiBase: 'http://local.invalid',
  managementKey: 'synthetic-only',
};
const view = {
  auth_index: 'exact-a',
  revision: 'r1',
  refresh_enabled: true,
  editable_fields: ['note', 'disabled', 'refresh_enabled'],
};
describe('ordinary settings API', () => {
  it('flattens envelopes and flat values without copying unknown fields', () => {
    expect(
      flattenOrdinarySettings({
        account_settings: { ...view, provider_owned: 'ignore' },
      })
    ).toEqual({ ...view, editable_fields: ['refresh_enabled'] });
    expect(flattenOrdinarySettings(view).refresh_enabled).toBe(true);
  });
  it('sends exact GET identity and scoped authorization', async () => {
    mock.get.mockResolvedValue({ account_settings: view });
    await api.get(target, scope);
    expect(mock.get).toHaveBeenCalledWith('/auth-files/account-settings', {
      captured: scope,
      params: { name: 'ordinary.json', auth_index: 'exact-a' },
    });
  });
  it('PATCH contains only four explicit ordinary fields', async () => {
    mock.patch.mockResolvedValue({ account_settings: view });
    await api.patch(target, 'r1', false, scope);
    expect(mock.patch).toHaveBeenCalledWith(
      '/auth-files/account-settings',
      {
        name: 'ordinary.json',
        auth_index: 'exact-a',
        revision: 'r1',
        refresh_enabled: false,
      },
      { captured: scope }
    );
  });
});
