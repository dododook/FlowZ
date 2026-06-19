import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';
import enUS from './locales/en-US.json';
import ru from './locales/ru.json';

const resources = {
  'zh-CN': {
    translation: zhCN,
  },
  'zh-TW': {
    translation: zhTW,
  },
  'en-US': {
    translation: enUS,
  },
  ru: {
    translation: ru,
  },
};

// 尝试从 localStorage 获取语言，默认简体中文
const savedLanguage = localStorage.getItem('app-language') || 'zh-CN';

i18n.use(initReactI18next).init({
  resources,
  lng: savedLanguage,
  fallbackLng: 'en-US',
  interpolation: {
    escapeValue: false,
  },
});

// 同步 <html lang>：初始化按当前语言设置，切换语言时随 languageChanged 更新。
// index.html 中静态的 lang="zh-CN" 仅作首屏默认，运行期以此为准。
i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
});
document.documentElement.lang = i18n.language;

export default i18n;
