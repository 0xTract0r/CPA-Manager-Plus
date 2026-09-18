import type { AuthFileItem } from '@/types/authFile';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const EMAIL_IN_TEXT_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

const readText = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value).trim();

export const stripAccountFileSuffix = (value: unknown): string =>
  readText(value).replace(/\.json$/i, '');

export const readEmailLike = (value: unknown): string => {
  const normalized = stripAccountFileSuffix(value);
  return EMAIL_PATTERN.test(normalized) ? normalized : '';
};

/**
 * 账号邮箱展示脱敏：保留本地部分前两位与完整域名，中段固定折叠。
 * 搜索和 API 匹配仍使用原始邮箱，掩码只用于可见文本。
 */
export const maskAccountEmail = (value: unknown): string => {
  const normalized = stripAccountFileSuffix(value);
  if (!normalized) return '';
  const email = readEmailLike(normalized);
  if (!email) {
    if (normalized.length <= 2) return normalized;
    return `${normalized[0]}***${normalized[normalized.length - 1]}`;
  }
  const [local, ...domainParts] = email.split('@');
  const domain = domainParts.join('@');
  const prefix = local.slice(0, local.length <= 2 ? 1 : 2);
  return `${prefix}${local.length > 2 ? '***' : '*'}@${domain}`;
};

export const maskAccountEmailsInText = (value: unknown): string =>
  readText(value).replace(EMAIL_IN_TEXT_PATTERN, (email) => maskAccountEmail(email));

/**
 * 认证文件名经常只是 `provider-<email>-suffix.json`。卡片同时展示邮箱时，把文件名中
 * 已重复的完整邮箱折叠成省略号；完整文件名仍通过弹层提供，不丢失运维识别能力。
 */
export const compactAuthFileNameForDisplay = (fileName: unknown, email: unknown): string => {
  const normalizedFileName = readText(fileName);
  const normalizedEmail = readEmailLike(email);
  if (!normalizedFileName || !normalizedEmail) return normalizedFileName;

  const index = normalizedFileName.toLowerCase().indexOf(normalizedEmail.toLowerCase());
  if (index < 0) return normalizedFileName;
  return `${normalizedFileName.slice(0, index)}…${normalizedFileName.slice(index + normalizedEmail.length)}`;
};

export type AccountIdentityInput = {
  note?: unknown;
  email?: unknown;
  fallback?: unknown;
};

export type AccountIdentityView = {
  note: string;
  email: string;
  maskedEmail: string;
  fallback: string;
  maskedFallback: string;
  primary: string;
  secondary: string;
  hasNote: boolean;
  primaryIsEmail: boolean;
  title: string;
};

export const resolveAccountIdentity = ({
  note,
  email,
  fallback,
}: AccountIdentityInput): AccountIdentityView => {
  const normalizedNote = readText(note);
  const normalizedFallback = stripAccountFileSuffix(fallback);
  // fallback 是文件名/内部标识，不再猜测成账号邮箱，避免同一卡片出现两个“邮箱”。
  const normalizedEmail = readEmailLike(email);
  const maskedEmail = normalizedEmail ? maskAccountEmail(normalizedEmail) : '';
  const maskedFallback = maskAccountEmailsInText(normalizedFallback);
  const hasNote = Boolean(normalizedNote);
  const primary = hasNote ? normalizedNote : normalizedEmail || normalizedFallback || '-';
  const secondary = hasNote ? normalizedEmail : '';
  const title = Array.from(
    new Set([normalizedNote, normalizedEmail, normalizedFallback].filter(Boolean))
  ).join(' · ');

  return {
    note: normalizedNote,
    email: normalizedEmail,
    maskedEmail,
    fallback: normalizedFallback,
    maskedFallback,
    primary,
    secondary,
    hasNote,
    primaryIsEmail: !hasNote && Boolean(normalizedEmail),
    title: title || primary,
  };
};

const getNestedNote = (file: AuthFileItem): string =>
  readText(file.account_settings?.note) || readText(file.accountSettings?.note);

export const readAuthFileNote = (file: AuthFileItem): string =>
  getNestedNote(file) ||
  readText(file.note) ||
  readText(file['account_note']) ||
  readText(file['remark']) ||
  readText(file['remarks']);

export const readAuthFileEmail = (file: AuthFileItem): string => {
  for (const value of [
    file.email,
    file.account,
    file['account_email'],
    file['user_email'],
    file['account_snapshot'],
    file['auth_label_snapshot'],
  ]) {
    const email = readEmailLike(value);
    if (email) return email;
  }
  return '';
};

export const resolveAuthFileAccountIdentity = (file: AuthFileItem): AccountIdentityView =>
  resolveAccountIdentity({
    note: readAuthFileNote(file),
    email: readAuthFileEmail(file),
    fallback: file.name || file.label || file.account || file.email,
  });

export const getAuthFileIdentitySearchValues = (file: AuthFileItem): string[] => {
  const identity = resolveAuthFileAccountIdentity(file);
  return Array.from(
    new Set(
      [
        identity.note,
        identity.email,
        identity.maskedEmail,
        file.name,
        file.label,
        file.account,
        file.email,
        file['account_snapshot'],
        file['auth_label_snapshot'],
        file.authIndex,
        file['auth_index'],
      ]
        .map(readText)
        .filter(Boolean)
    )
  );
};

export type AccountIdentityReference = {
  authIndex?: unknown;
  fileName?: unknown;
  email?: unknown;
  accountId?: unknown;
  provider?: unknown;
};

const normalizedComparable = (value: unknown) => readText(value).toLowerCase();

/**
 * 用强身份键关联当前 auth file；分数只用于在多个兼容键同时出现时选择最具体项。
 * 没有任何强键命中时返回 undefined，禁止仅凭重复备注做关联。
 */
export const findAuthFileForIdentity = (
  files: readonly AuthFileItem[],
  reference: AccountIdentityReference
): AuthFileItem | undefined => {
  const authIndex = normalizedComparable(reference.authIndex);
  const fileName = normalizedComparable(reference.fileName);
  const email = normalizedComparable(readEmailLike(reference.email));
  const accountId = normalizedComparable(reference.accountId);
  const provider = normalizedComparable(reference.provider);

  let best: { file: AuthFileItem; score: number } | undefined;
  files.forEach((file) => {
    const fileAuthIndex = normalizedComparable(file['auth_index'] ?? file.authIndex);
    const fileNameValue = normalizedComparable(file.name);
    const fileEmail = normalizedComparable(readAuthFileEmail(file));
    const fileAccountId = normalizedComparable(
      file['account_id'] ?? file['accountId'] ?? file['chatgpt_account_id']
    );
    const fileProvider = normalizedComparable(file.provider || file.type);
    let score = 0;
    if (authIndex && fileAuthIndex === authIndex) score += 100;
    if (fileName && fileNameValue === fileName) score += 80;
    if (accountId && fileAccountId === accountId) score += 60;
    if (email && fileEmail === email) score += 40;
    if (score > 0 && provider && fileProvider === provider) score += 10;
    if (score > (best?.score ?? 0)) best = { file, score };
  });
  return best?.file;
};

export const findAuthIndicesMatchingIdentityQuery = (
  files: readonly AuthFileItem[],
  query: string
): string[] => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  return Array.from(
    new Set(
      files
        .filter((file) =>
          [readAuthFileNote(file), readAuthFileEmail(file)]
            .filter(Boolean)
            .some((value) => value.toLowerCase().includes(normalized))
        )
        .map((file) => readText(file['auth_index'] ?? file.authIndex))
        .filter(Boolean)
    )
  );
};

export const withIdentitySearchAuthIndices = <T extends object>(
  filters: T,
  authIndices: readonly string[]
): T & { search_auth_indices?: string[] } => {
  const normalized = Array.from(new Set(authIndices.map(readText).filter(Boolean)));
  return normalized.length > 0
    ? { ...filters, search_auth_indices: normalized }
    : (filters as T & { search_auth_indices?: string[] });
};
