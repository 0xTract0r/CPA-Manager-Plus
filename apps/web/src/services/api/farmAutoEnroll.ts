/**
 * 「全局自动纳管新号」开关（core 管理端点，非农场编排器）。
 *
 * 契约（core 侧固定为 { "value": bool }）：
 * - GET /v0/management/farm-auto-enroll        → { value: bool }
 * - PUT /v0/management/farm-auto-enroll  body: { value: bool } → { value: bool }（回显）
 *
 * 刻意走通用 core 管理 client（apiClient，services/api/client.ts），与
 * authFilesApi.getAccountSettings 同一套鉴权/base——apiClient 的 baseURL 由
 * computeApiUrl 追加 MANAGEMENT_API_PREFIX（/v0/management），所以这里的相对路径
 * 只写 `/farm-auto-enroll`，不重复前缀。**不要**用 farmClient/orchestrator：那是
 * 农场编排器（18450）的运行时开关，与「新号是否进农场名单」是两回事：
 * - 自动纳管（本端点，打 core）：决定新认证账号是否进入农场纳管名单（per-account
 *   farm_enrolled 的全局默认）。
 * - 自动供给（farmApi.updateConfig，打编排器）：决定已纳管账号是否自动建运行容器。
 */

import { apiClient } from './client';

export interface FarmAutoEnrollResponse {
  // 全局开关真值：true=新号默认自动纳入农场；false=新号需手动纳管。
  value: boolean;
}

const FARM_AUTO_ENROLL_ENDPOINT = '/farm-auto-enroll';

export const farmAutoEnrollApi = {
  // 读当前全局默认。
  get: () => apiClient.get<FarmAutoEnrollResponse>(FARM_AUTO_ENROLL_ENDPOINT),

  // 写全局默认（幂等）；成功 200 回显设置后的真值，调用方以回显为准。
  set: (value: boolean) =>
    apiClient.put<FarmAutoEnrollResponse>(FARM_AUTO_ENROLL_ENDPOINT, { value }),
};
