/**
 * 农场账号标识展示口径（#52）：运营者主要用「备注名」认账号，裸邮箱既不好认、
 * 也是敏感信息。凡是农场 UI 里要展示绑定账号 / 账号身份的地方，统一走这里：
 * 备注名（note）优先作为主标识，邮箱脱敏后作为次要标识。
 */

/**
 * 邮箱脱敏：保留本地部分前 2 位 + 域名，中间用 `***` 掩盖，避免明文暴露完整邮箱
 * （降特征）。非邮箱字符串（无 `@`）按「首字符 + *** + 尾字符」掩盖；过短串原样
 * 返回。空串返回空串。
 */
export function maskAccountEmail(value?: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return '';
  const at = trimmed.indexOf('@');
  if (at <= 0) {
    if (trimmed.length <= 2) return trimmed;
    return `${trimmed[0]}***${trimmed[trimmed.length - 1]}`;
  }
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at); // 含前导 '@'
  const maskedLocal = local.length <= 2 ? `${local[0] ?? ''}*` : `${local.slice(0, 2)}***`;
  return `${maskedLocal}${domain}`;
}

export interface BindingIdentityLabels {
  /** 主标识：备注名优先，无备注时回退到脱敏邮箱（再无则原始标识 / 空）。 */
  primary: string;
  /** 次要标识：有备注名时展示脱敏邮箱；无备注名时为空（主标识已是脱敏邮箱）。 */
  secondary: string;
  /** 是否有备注名（决定是否展示 secondary 行）。 */
  hasNote: boolean;
}

/**
 * 由「备注名 + 邮箱/账号」派生绑定账号的主/次标识（#52）。
 * - 有备注名：primary=备注名，secondary=脱敏邮箱。
 * - 无备注名：primary=脱敏邮箱，secondary=''（不再重复展示）。
 */
export function resolveBindingIdentity(
  note: string | undefined,
  account: string | undefined
): BindingIdentityLabels {
  const trimmedNote = note?.trim();
  const maskedAccount = maskAccountEmail(account);
  if (trimmedNote) {
    return { primary: trimmedNote, secondary: maskedAccount, hasNote: true };
  }
  return { primary: maskedAccount || (account?.trim() ?? ''), secondary: '', hasNote: false };
}
