import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { STORAGE_KEY_ACCOUNT_PRIVACY } from '@/utils/constants';

interface AccountPrivacyState {
  maskEmails: boolean;
  setMaskEmails: (maskEmails: boolean) => void;
  toggleMaskEmails: () => void;
}

export const useAccountPrivacyStore = create<AccountPrivacyState>()(
  persist(
    (set, get) => ({
      // CPAMP 是受控运维面板，沿用历史行为：默认直接显示完整账号邮箱。
      maskEmails: false,
      setMaskEmails: (maskEmails) => set({ maskEmails }),
      toggleMaskEmails: () => set({ maskEmails: !get().maskEmails }),
    }),
    {
      name: STORAGE_KEY_ACCOUNT_PRIVACY,
      partialize: (state) => ({ maskEmails: state.maskEmails }),
    }
  )
);
