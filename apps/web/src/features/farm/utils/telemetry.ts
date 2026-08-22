/**
 * 每容器遥测指纹自洽卡的两条纯逻辑（TP-1「点亮 on-wire 逐字段」）：展示脱敏 +
 * 撞红判定。从 <FarmTelemetryPanel> 抽出成独立纯函数，一是让「先用原始值判等、
 * 再各自脱敏展示」这条硬约束（见 identity.ts maskTelemetryFingerprint 注释）可被
 * 单测锁死，二是让组件层只做渲染、不夹带判定逻辑。
 */
import { maskTelemetryFingerprint } from './identity';

// 高熵指纹字段：展示前必须脱敏（前 12 + 后 4，见 maskTelemetryFingerprint）。
// device_id / session_id 是高熵定长哈希/UUID，直出会多暴露特征；host / entrypoint
// 之类低熵字段（如 api.anthropic.com / claude-cli）不脱敏，脱敏反而降低可读性。
export const FARM_HIGH_ENTROPY_FINGERPRINT_FIELDS: ReadonlySet<string> = new Set([
  'device_id',
  'session_id',
]);

/**
 * 指纹字段的**展示串**：高熵字段脱敏，其余原样。空串原样返回空串。
 * 注意——只用于展示；判等/撞红必须先用原始值（见 fingerprintFieldsClash）。
 */
export function displayFingerprintValue(field: string, raw: string): string {
  if (!raw) return '';
  return FARM_HIGH_ENTROPY_FINGERPRINT_FIELDS.has(field)
    ? maskTelemetryFingerprint(raw)
    : raw;
}

/**
 * declared 与 on-wire 同一字段是否撞红（不一致）。**必须传原始值，不能传脱敏串**
 * （脱敏会把两个首尾恰好相同的不同值误判为一致）。三态语义：
 *   - onWireRaw === null：从未观测到 on-wire beacon（真占位）→ 不比较，false。
 *   - 任一侧为空串：该来源这次没带这个字段（如 datadog_logs 通道无 device_id）
 *     → 不构成冲突，false，避免把「没带」误判成「冲突」而误红。
 *   - 两侧都非空且不同 → true（撞红）。
 */
export function fingerprintFieldsClash(
  declaredRaw: string,
  onWireRaw: string | null
): boolean {
  if (onWireRaw === null) return false;
  if (declaredRaw === '' || onWireRaw === '') return false;
  return declaredRaw !== onWireRaw;
}
