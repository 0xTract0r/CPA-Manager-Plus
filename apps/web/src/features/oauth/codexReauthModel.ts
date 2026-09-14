import type { AuthFileItem } from '@/types';
import { resolveAuthFileAccountIdentity } from '@/utils/accountIdentity';

export type CodexReauthTarget = {
  account: string;
  note?: string;
  email?: string;
  fileName?: string;
  authIndex?: string | number | null;
  accountId?: string | null;
};

const readStringField = (source: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
};

export const createCodexReauthTargetFromAuthFile = (file: AuthFileItem): CodexReauthTarget => {
  const record = file as Record<string, unknown>;
  const identity = resolveAuthFileAccountIdentity(file);
  const account =
    identity.email ||
    readStringField(record, [
      'email',
      'account',
      'displayAccount',
      'display_account',
      'accountEmail',
      'account_email',
      'user',
      'username',
    ]) ||
    file.name;
  const accountId =
    readStringField(record, [
      'accountId',
      'account_id',
      'chatgptAccountId',
      'chatgpt_account_id',
    ]) || null;
  return {
    account,
    note: identity.note || undefined,
    email: identity.email || undefined,
    fileName: file.name,
    authIndex: (record.authIndex ?? record.auth_index ?? null) as string | number | null,
    accountId,
  };
};
