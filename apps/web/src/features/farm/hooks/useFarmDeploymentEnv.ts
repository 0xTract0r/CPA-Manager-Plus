import { useEffect, useState } from 'react';
import { usageServiceApi } from '@/services/api/usageService';
import { detectApiBaseFromLocation } from '@/utils/connection';
import type { FarmEnv } from '@/types/farm';

/**
 * useFarmDeploymentEnv：解析「本 cpamp 部署实例管哪个环境」（prod / test），供农场页
 * 按真实部署环境请求，替掉前端写死的 env='test'（生产 cpamp 曾因此错请求测试环境）。
 *
 * 数据来源：GET /usage-service/info 的 farmEnv 字段——manager-server 先看 FARM_ENV，
 * 为空时从它连接的编排器 URL 端口兜底推断（:18451→prod，否则 test）。同源探测复用
 * detectApiBaseFromLocation（与 ProtectedRoute 一致），cpamp 自托管页面无需手填 base。
 *
 * 回退策略：加载中、接口缺字段或请求失败一律回退 'test'（绝不回退 'prod'）——保持与
 * 历史行为一致，避免测试部署被误判成生产；生产部署则在 info 返回后自动校正为 'prod'。
 *
 * resolved 标志：区分「env 还没解析出来（仍是回退值 'test'）」与「已从 info 校正」。
 * 消费方（农场页账号查询）在 resolved 前不应发请求——否则生产页加载期会先拿回退
 * 'test' 打到测试环境 CPA（错环境、还污染测试端失败计数），等 info 返回才切 'prod'
 * 重发。成功和失败分支都置 resolved=true（失败也已确定回退为 'test'，不再是待定态）。
 */
export interface UseFarmDeploymentEnvResult {
  env: FarmEnv;
  /** false 表示 env 尚未从 /usage-service/info 解析出来（仍是回退值），消费方应据此 gate 掉请求。 */
  resolved: boolean;
}

export function useFarmDeploymentEnv(): UseFarmDeploymentEnvResult {
  const [env, setEnv] = useState<FarmEnv>('test');
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      try {
        const info = await usageServiceApi.getInfo(detectApiBaseFromLocation());
        if (!cancelled) {
          setEnv(info.farmEnv ?? 'test');
          setResolved(true);
        }
      } catch {
        if (!cancelled) {
          setEnv('test');
          setResolved(true);
        }
      }
    };
    resolve();
    return () => {
      cancelled = true;
    };
  }, []);

  return { env, resolved };
}
