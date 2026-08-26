/**
 * 每容器遥测指纹自洽卡的纯逻辑（TP-1「点亮 on-wire 逐字段」+ farm-proxy-rotation
 * §5「指纹卡 pin」）：展示脱敏 + 撞红判定。从 <FarmTelemetryPanel> 抽出成独立纯
 * 函数，一是让「先用原始值判等、再各自脱敏展示」这条硬约束（见 identity.ts
 * maskTelemetryFingerprint 注释）可被单测锁死，二是让组件层只做渲染、不夹带判定
 * 逻辑。
 *
 * §5 把指纹卡的「declared (自报)」列换成「预期 (pin)」：数据源从容器自报 beacon
 * 换成编排器钉给该容器的意图身份（container.fingerprint_pin，types/farm.ts
 * FarmContainerView 注释），仍逐字段对照 on-wire 实测。fingerprintFieldsClash 的
 * 三态判等语义原样复用，新增 pinFieldClash 只是包一层「先按同款规则脱敏 on-wire
 * 值，再与 pin 值比对」——因为 pin 的 device_id 一项从后端起就只有脱敏串可用（绝不
 * 下发明文，见下方 pinFieldClash 注释）。
 *
 * 注意：<FarmTelemetryPanel> 因 NOCLASH 并行改动约束冻结了自己的 import 行，未直接
 * import pinFieldRawValue / pinFieldClash，而是内联复刻了等价逻辑；这里是规范实现
 * + 单测锁定，留给集成阶段把两处收敛成一份。
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

// ---------------------------------------------------------------------------
// farm-proxy-rotation §5「指纹卡 pin」：指纹自洽卡的「declared」列换成「预期(pin)」
// ——数据源从容器自报 beacon 换成编排器钉给该容器的意图身份
// （container.fingerprint_pin，types/farm.ts FarmContainerView 注释）。三字段与
// FARM_HIGH_ENTROPY_FINGERPRINT_FIELDS / 上方判等逻辑对应的字段名一致，只是 pin
// 结构里 device_id 一项改叫 device_id_masked（后端绝不下发明文），这里集中做一次
// 字段映射 + 判等，调用方（<FarmTelemetryPanel>）不用各自硬编码。
// ---------------------------------------------------------------------------

/** container.fingerprint_pin 的对外形状（与 types/farm.ts FarmContainerView 保持一致）。 */
export interface FarmFingerprintPin {
  device_id_masked: string;
  entrypoint: string;
  api_base_url_host: string;
}

export type FarmFingerprintPinField = 'device_id' | 'entrypoint' | 'api_base_url_host';

/**
 * 从「预期(pin)」结构取某个指纹字段的预期值。pin 缺失（旧编排器/字段裁剪防御，
 * 正常情况后端恒填充）时返回空串，调用方按「未配置(pin)」处理，不臆造；下游
 * fingerprintFieldsClash 对空串走「不构成冲突」分支，故 pin 缺失也不会误撞红。
 */
export function pinFieldRawValue(
  pin: FarmFingerprintPin | undefined,
  field: FarmFingerprintPinField
): string {
  if (!pin) return '';
  switch (field) {
    case 'device_id':
      return pin.device_id_masked;
    case 'entrypoint':
      return pin.entrypoint;
    case 'api_base_url_host':
      return pin.api_base_url_host;
    default:
      return '';
  }
}

/**
 * 「预期(pin)」与 on-wire 实测同一字段是否撞红（=泄露）。复用
 * fingerprintFieldsClash 的三态判等语义（never observed / 该来源本次未带值 / 真
 * 撞红），只是比较前先把 on-wire 原始值按 displayFingerprintValue 同款规则处理
 * 一遍，落到与 pinRaw 相同的表示层级再比。
 *
 * 这不是绕开「必须用原始值判等」的硬约束：pin.device_id_masked 从后端起就只有
 * 脱敏值（绝不下发明文 device_id，见 types/farm.ts fingerprint_pin 注释），前端
 * 压根拿不到可比的原始 pin 值，「两侧都按同款规则脱敏后比对」已经是这个场景下能
 * 做到的最强判据；entrypoint / api_base_url_host 是低熵字段，displayFingerprintValue
 * 对它们原样返回，等价仍是原始值比较，不受影响。
 */
export function pinFieldClash(
  field: FarmFingerprintPinField,
  pinRaw: string,
  onWireRaw: string | null
): boolean {
  const onWireComparable = onWireRaw === null ? null : displayFingerprintValue(field, onWireRaw);
  return fingerprintFieldsClash(pinRaw, onWireComparable);
}
