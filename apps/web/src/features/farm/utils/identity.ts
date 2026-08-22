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

/**
 * 剥掉账号标识尾部的 `.json` 后缀（#52 尾项）。农场绑定账号在无备注名时会回退到
 * auth 文件名（形如 `claude@gmail.com.json`），脱敏后会显示成 `cl***@gmail.com.json`，
 * `.json` 属于文件名工件、不是账号本体，展示前统一剥掉。大小写不敏感，顺带 trim。
 */
export function stripJsonSuffix(value?: string): string {
  const trimmed = value?.trim() ?? '';
  return trimmed.replace(/\.json$/i, '');
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
  // 先剥掉尾部 `.json`（auth 文件名工件），再脱敏，避免显示成 `cl***@gmail.com.json`。
  const normalizedAccount = stripJsonSuffix(account);
  const maskedAccount = maskAccountEmail(normalizedAccount);
  if (trimmedNote) {
    return { primary: trimmedNote, secondary: maskedAccount, hasNote: true };
  }
  return { primary: maskedAccount || normalizedAccount, secondary: '', hasNote: false };
}

/**
 * 遥测指纹字段脱敏口径（TP-1/TP-2「每容器遥测内容抓取」，与上方账号邮箱脱敏是
 * 两套独立策略，服务不同字段）：device_id / session_id 这类高熵定长哈希/UUID
 * 保留前 12 位 + 后 4 位，中间用省略号折叠。与容器列表 `device_id_masked`
 * （只保留前 16 位、无后缀）刻意不同——运维核对跨容器/跨账号漂移、串号、
 * 事故取证时，首尾两段比只暴露前缀更容易目视排除掉“前缀相同但确实是两个不同
 * 设备”的情形。可见字符预算与列表页一致（12+4=16 位），不额外多暴露。
 *
 * 注意：这里只处理**展示层**掩码，禁止用掩码后的字符串做相等性比较（会把两个
 * 真实不同但首尾恰好相同的值误判为一致）——调用方必须先用原始值判等/撞红，
 * 再各自独立地把两侧原始值分别喂进本函数得到展示串（参见
 * FarmTelemetryPanel.tsx 指纹自洽卡的 clash 判定顺序）。
 *
 * 短于「前 12 + 后 4」总长度（16）的输入无法有意义地折叠中段，原样返回；
 * 空/未定义返回空串。
 */
export function maskTelemetryFingerprint(value?: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return '';
  const PREFIX_LEN = 12;
  const SUFFIX_LEN = 4;
  if (trimmed.length <= PREFIX_LEN + SUFFIX_LEN) return trimmed;
  return `${trimmed.slice(0, PREFIX_LEN)}…${trimmed.slice(-SUFFIX_LEN)}`;
}
