/**
 * 版本相关 API
 */

import axios from 'axios';
import { getDemoManagerLatestRelease } from '@/features/demo/demoFixtures';
import { isDemoMode } from '@/features/demo/demoMode';
const CPA_MANAGER_LATEST_RELEASE_URL = 'https://api.github.com/repos/0xTract0r/CPA-Manager-Plus/releases/latest';
import { getLocalSnapshotTime } from '@/utils/localSnapshot';
import { REQUEST_TIMEOUT_MS } from '@/utils/constants';
import { apiClient } from './client';

export const CPA_MANAGER_UPDATE_INDEX_URL =
  'https://raw.githubusercontent.com/0xTract0r/CPA-Manager-Plus/update-channel/update-index.json';

export interface ManagerLatestRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
  [key: string]: unknown;
}

export const versionApi = {
  checkLatest: () => apiClient.get<Record<string, unknown>>('/latest-version'),

  checkManagerLatest: async () => {
    // 只读快照没有在线更新状态，避免后台访问外部发布服务。
    if (getLocalSnapshotTime() !== undefined) return {};
    if (__DEMO_SITE__ && isDemoMode()) {
      return getDemoManagerLatestRelease();
    }

    const response = await axios.get<ManagerLatestRelease>(CPA_MANAGER_LATEST_RELEASE_URL, {
      timeout: REQUEST_TIMEOUT_MS,
    });
    return response.data;
  },
  checkManagerUpdateIndex: async () => {
    if (getLocalSnapshotTime() !== undefined) return {};
    const response = await axios.get(CPA_MANAGER_UPDATE_INDEX_URL, {
      timeout: REQUEST_TIMEOUT_MS,
    });
    return response.data;
  },
};
