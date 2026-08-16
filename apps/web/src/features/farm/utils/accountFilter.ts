/**
 * 账号健康面板筛选纯函数（P2-C8「筛选维度改造」）。
 *
 * 背景：账号面板此前的 test/prod「环境」下拉在实际部署里无意义——测试端编排器
 * 只服务测试账号、生产账号不会出现（farm-orchestrator 当前仅 test 环境）。用户
 * 挑账号时真正需要的是「按账号认证态过滤」和「按备注/账号名搜索」，故把环境
 * 下拉换成这两个客户端筛选维度。
 *
 * 判定逻辑抽成纯函数，与 <FarmAccountsPanel> 的徽标/节奏渲染解耦，便于单测覆盖
 * 组合条件（认证态 + 关键词同时收窄）而不必渲染整个面板。
 */

import type { FarmAccountAuthState } from './health';

/**
 * 账号认证态筛选取值：
 * - 'all'：不按认证态过滤。
 * - 'normal'：**复合筛选**——已绑定容器（farm_bound）且认证健康（healthy），
 *   排除 unprovisioned/operator_disabled/auto_quarantined/needs_reauth/unknown。
 *   用户拍板「只有绑定 + 健康才算正常」，这是账号面板的默认筛选。
 * - 其余：复用 6 态枚举做精确态过滤。
 */
export type FarmAccountAuthFilter = FarmAccountAuthState | 'all' | 'normal';

/** 单行参与筛选所需的最小字段（认证态由面板按 C1-C5 同款口径派生后传入）。 */
export interface FarmAccountFilterRow {
  /** 账号备注（如 "AC04"），可空。 */
  note?: string;
  /** CPA 邮箱账号（如 "acct1@example.com"），可空。 */
  account?: string;
  /** auth 文件名（恒有值）。 */
  name: string;
  /** 该账号的认证态 6 态（面板用 deriveAccountAuthState 派生，与徽标同源）。 */
  authState: FarmAccountAuthState;
  /**
   * 该账号是否已绑定农场容器（契约字段 farm_bound）。'normal' 复合筛选需要它；
   * 缺省时防御式当作已绑定处理（healthy 在新模型下已隐含绑定，见 deriveAccountAuthState）。
   */
  farmBound?: boolean;
}

/** 判定某账号行是否属于「正常」（绑定 + 健康）。healthy 在 6 态模型下已隐含绑定
 * （未绑定 Claude 会被判为 unprovisioned），此处再显式核对 farmBound !== false 以
 * 防御后端过渡期 farm_bound 与 authState 口径不一致。 */
export function isNormalFarmAccountRow(row: Pick<FarmAccountFilterRow, 'authState' | 'farmBound'>): boolean {
  return row.authState === 'healthy' && row.farmBound !== false;
}

/** 当前生效的筛选条件。 */
export interface FarmAccountFilterCriteria {
  /** 认证态过滤；'all' 表示不按认证态收窄。 */
  authState: FarmAccountAuthFilter;
  /** 备注/账号/文件名关键词；空串或纯空白表示不按关键词收窄。 */
  query: string;
}

/**
 * 判定某账号行是否命中当前筛选。两个维度是「与」关系：认证态先收窄，再按
 * 关键词（大小写不敏感、去首尾空白）在 note / account / name 三处做子串匹配。
 * 关键词为空时只按认证态；认证态为 'all' 时只按关键词；两者都为空则恒命中。
 */
export function matchesFarmAccountFilter(
  row: FarmAccountFilterRow,
  criteria: FarmAccountFilterCriteria
): boolean {
  if (criteria.authState === 'normal') {
    // 复合「正常」= 绑定 + 健康；其它一切态（含 unprovisioned/unknown）都排除。
    if (!isNormalFarmAccountRow(row)) return false;
  } else if (criteria.authState !== 'all' && row.authState !== criteria.authState) {
    return false;
  }
  const q = criteria.query.trim().toLowerCase();
  if (q === '') return true;
  return [row.note, row.account, row.name].some(
    (value) => typeof value === 'string' && value.toLowerCase().includes(q)
  );
}
