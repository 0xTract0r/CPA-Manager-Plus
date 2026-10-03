import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/global.scss';
import { INLINE_LOGO_JPEG } from '@/assets/logoInline';
import { useAuthStore, useLanguageStore, useThemeStore } from '@/stores';
import { getLocalSnapshotAccess } from '@/utils/localSnapshot';
import { setTimeZone } from '@/utils/timezone';
import App from './App.tsx';

document.title = 'CPA Manager Plus';
document.documentElement.setAttribute('translate', 'no');
document.documentElement.classList.add('notranslate');

const faviconEl = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
if (faviconEl) {
  faviconEl.href = INLINE_LOGO_JPEG;
  faviconEl.type = 'image/jpeg';
} else {
  const newFavicon = document.createElement('link');
  newFavicon.rel = 'icon';
  newFavicon.type = 'image/jpeg';
  newFavicon.href = INLINE_LOGO_JPEG;
  document.head.appendChild(newFavicon);
}

async function startApp() {
  try {
    const previewAccess = await getLocalSnapshotAccess();
    if (previewAccess) {
      useThemeStore.getState().setTheme('wool');
      useLanguageStore.getState().setLanguage('zh-CN');
      setTimeZone('Asia/Shanghai');
      await useAuthStore.getState().login({
        apiBase: window.location.origin,
        managementKey: previewAccess,
        rememberPassword: false,
        sessionMode: 'manager_embedded',
        sessionPanelBase: window.location.origin,
      });
    }
  } catch {
    // 服务未确认时沿用正式登录流程，不放宽鉴权。
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

void startApp();
