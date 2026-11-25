import { apiClient, createScopedApiRequestConfig, type ApiClientRequestScope } from './client';
import type { OrdinaryRefreshSettings } from '@/types/authFile';
export type OrdinarySettingsTarget = { name: string; authIndex: string };
export class OrdinarySettingsUnsupported extends Error {}
export function flattenOrdinarySettings(payload: unknown): OrdinaryRefreshSettings {
  const envelope = payload as { account_settings?: unknown } | null;
  const raw = (envelope?.account_settings ?? payload) as Partial<OrdinaryRefreshSettings> | null;
  if (!raw || typeof raw !== 'object') throw new Error('invalid account settings response');
  if (
    typeof raw.refresh_enabled !== 'boolean' ||
    !Array.isArray(raw.editable_fields) ||
    !raw.editable_fields.includes('refresh_enabled') ||
    !raw.revision
  ) {
    throw new OrdinarySettingsUnsupported();
  }
  if (
    typeof raw.auth_index !== 'string' ||
    !raw.auth_index.trim() ||
    typeof raw.revision !== 'string' ||
    !raw.revision.trim()
  )
    throw new Error('invalid account settings identity');
  return {
    auth_index: raw.auth_index,
    revision: raw.revision,
    refresh_enabled: raw.refresh_enabled,
    editable_fields: ['refresh_enabled'],
  };
}
export const ordinaryAccountSettingsApi = {
  async get(target: OrdinarySettingsTarget, scope: ApiClientRequestScope) {
    return flattenOrdinarySettings(
      await apiClient.get('/auth-files/account-settings', {
        ...createScopedApiRequestConfig(scope),
        params: { name: target.name, auth_index: target.authIndex },
      })
    );
  },
  async patch(
    target: OrdinarySettingsTarget,
    revision: string,
    enabled: boolean,
    scope: ApiClientRequestScope
  ) {
    return flattenOrdinarySettings(
      await apiClient.patch(
        '/auth-files/account-settings',
        {
          name: target.name,
          auth_index: target.authIndex,
          revision,
          refresh_enabled: enabled,
        },
        createScopedApiRequestConfig(scope)
      )
    );
  },
};
