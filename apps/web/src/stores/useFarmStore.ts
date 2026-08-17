/**
 * 农场编排器（Device Farm）连接状态管理
 *
 * 默认零配置：orchestratorBaseUrl / farmAdminKey 均为空字符串，代表"同源代理
 * 模式"——farmClient 请求打相对路径 `/api/farm/*`，鉴权复用当前 cpamp 会话的
 * managementKey（见 farmClient.ts 顶部注释）。operator 不需要做任何事，农场页
 * 默认即可用。
 *
 * FarmConfigPanel 现在是"高级覆盖"入口：填了 base URL + admin key，才会切到
 * 直连另一个独立编排器实例的模式；清空则退回同源代理默认。isConfigured 语义：
 * 同源默认模式与"两者都填齐"的覆盖模式都视为 true（可用）；只有覆盖半填
 * （只填了其中一项）才是 false（配置无效的中间态）。
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { farmClient } from '@/services/api/farmClient';
import { obfuscatedStorage } from '@/services/storage/secureStorage';
import { STORAGE_KEY_FARM } from '@/utils/constants';

interface FarmState {
  orchestratorBaseUrl: string;
  farmAdminKey: string;
  isConfigured: boolean;

  setConfig: (config: { orchestratorBaseUrl: string; farmAdminKey: string }) => void;
  clearConfig: () => void;
}

const normalizeBaseUrl = (input: string): string => {
  const trimmed = (input || '').trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
};

export const useFarmStore = create<FarmState>()(
  persist(
    (set) => ({
      orchestratorBaseUrl: '',
      farmAdminKey: '',
      // 默认零配置：未设置任何高级覆盖时，农场页本来就可用（同源代理 +
      // 会话身份），isConfigured 默认 true——不再是"必须先手填地址/key"的门。
      isConfigured: true,

      setConfig: ({ orchestratorBaseUrl, farmAdminKey }) => {
        const baseUrl = normalizeBaseUrl(orchestratorBaseUrl);
        const adminKey = (farmAdminKey || '').trim();
        farmClient.setConfig({ baseUrl, adminKey });
        set({
          orchestratorBaseUrl: baseUrl,
          farmAdminKey: adminKey,
          isConfigured: farmClient.isConfigured(),
        });
      },

      clearConfig: () => {
        farmClient.setConfig({ baseUrl: '', adminKey: '' });
        set({ orchestratorBaseUrl: '', farmAdminKey: '', isConfigured: true });
      },
    }),
    {
      name: STORAGE_KEY_FARM,
      storage: createJSONStorage(() => ({
        getItem: (name) => {
          const data = obfuscatedStorage.getItem<FarmState>(name);
          return data ? JSON.stringify(data) : null;
        },
        setItem: (name, value) => {
          obfuscatedStorage.setItem(name, JSON.parse(value));
        },
        removeItem: (name) => {
          obfuscatedStorage.removeItem(name);
        },
      })),
      partialize: (state) => ({
        orchestratorBaseUrl: state.orchestratorBaseUrl,
        farmAdminKey: state.farmAdminKey,
        isConfigured: state.isConfigured,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // 持久化数据恢复后，同步把 base URL / admin key 灌进 farmClient 单例；
        // 没有覆盖时显式回落到同源代理默认（baseUrl='' / adminKey=''），否则
        // 刷新页面后 store 已清空但 axios 实例仍残留上一次的覆盖配置。
        if (state.orchestratorBaseUrl || state.farmAdminKey) {
          farmClient.setConfig({
            baseUrl: state.orchestratorBaseUrl,
            adminKey: state.farmAdminKey,
          });
        } else {
          farmClient.setConfig({ baseUrl: '', adminKey: '' });
        }
        // 迁移旧版本持久化数据：老版本里"从未配置"会存下 isConfigured=false，
        // 按当前"同源默认即已就绪"的新语义重新计算，不能直接信任存储里的旧值。
        const nextIsConfigured = farmClient.isConfigured();
        if (state.isConfigured !== nextIsConfigured) {
          useFarmStore.setState({ isConfigured: nextIsConfigured });
        }
      },
    }
  )
);
