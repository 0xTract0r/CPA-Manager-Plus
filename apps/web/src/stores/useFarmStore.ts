/**
 * 农场编排器（Device Farm）配置状态管理
 *
 * 农场编排器是独立后端，走独立 base URL + 独立 admin key，绝不复用
 * CPA 的 useAuthStore/apiClient 单例（见 farmClient.ts 顶部注释）。配置入口
 * 是农场页内自带的配置面板（FarmConfigPanel），不是 CPA 登录页。
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
      isConfigured: false,

      setConfig: ({ orchestratorBaseUrl, farmAdminKey }) => {
        const baseUrl = normalizeBaseUrl(orchestratorBaseUrl);
        const adminKey = (farmAdminKey || '').trim();
        farmClient.setConfig({ baseUrl, adminKey });
        set({
          orchestratorBaseUrl: baseUrl,
          farmAdminKey: adminKey,
          isConfigured: Boolean(baseUrl && adminKey),
        });
      },

      clearConfig: () => {
        farmClient.setConfig({ baseUrl: '', adminKey: '' });
        set({ orchestratorBaseUrl: '', farmAdminKey: '', isConfigured: false });
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
        // 持久化数据恢复后，同步把 base URL / admin key 灌进 farmClient 单例，
        // 否则刷新页面后 store 有值但 axios 实例仍是空配置。
        if (state?.orchestratorBaseUrl && state?.farmAdminKey) {
          farmClient.setConfig({
            baseUrl: state.orchestratorBaseUrl,
            adminKey: state.farmAdminKey,
          });
        }
      },
    }
  )
);
