import { useEffect } from 'react';
import { useLanguageStore, useThemeStore, useVisualEffectsStore } from '@/stores';
import { setTimeZone } from '@/utils/timezone';

export function AppLifecycle() {
  const initializeTheme = useThemeStore((state) => state.initializeTheme);
  const initializeVisualEffects = useVisualEffectsStore((state) => state.initializeVisualEffects);
  const language = useLanguageStore((state) => state.language);
  const setLanguage = useLanguageStore((state) => state.setLanguage);

  useEffect(() => {
    const cleanupTheme = initializeTheme();
    return cleanupTheme;
  }, [initializeTheme]);

  useEffect(() => {
    initializeVisualEffects();
  }, [initializeVisualEffects]);

  useEffect(() => {
    setLanguage(language);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 仅用于首屏同步 i18n 语言

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  // 仅 demo 预览构建（dev:demo / __DEMO_SITE__）：把本地预览默认对齐测试端观感——
  // 牛皮纸主题 + 简体中文 + Asia/Shanghai(UTC+8)，省得每次手动切；生产构建不含此分支。
  useEffect(() => {
    if (!__DEMO_SITE__) {
      return;
    }
    useThemeStore.getState().setTheme('wool');
    useLanguageStore.getState().setLanguage('zh-CN');
    setTimeZone('Asia/Shanghai');
  }, []);

  return null;
}
