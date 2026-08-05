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

/** 账号认证态筛选取值：'all' = 不按认证态过滤，其余复用 5 态枚举。 */
export type FarmAccountAuthFilter = FarmAccountAuthState | 'all';

/** 单行参与筛选所需的最小字段（认证态由面板按 C1-C5 同款口径派生后传入）。 */
export interface FarmAccountFilterRow {
  /** 账号备注（如 "AC04"），可空。 */
  note?: string;
  /** CPA 邮箱账号（如 "acct1@example.com"），可空。 */
  account?: string;
  /** auth 文件名（恒有值）。 */
  name: string;
  /** 该账号的认证态 5 态（面板用 deriveAccountAuthState 派生，与徽标同源）。 */
  authState: FarmAccountAuthState;
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
  if (criteria.authState !== 'all' && row.authState !== criteria.authState) {
    return false;
  }
  const q = criteria.query.trim().toLowerCase();
  if (q === '') return true;
  return [row.note, row.account, row.name].some(
    (value) => typeof value === 'string' && value.toLowerCase().includes(q)
  );
}
