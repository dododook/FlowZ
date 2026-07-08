import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './assets/fonts/fonts.css';
import './index.css';
import './conduit.css'; // Conduit 设计系统（1:1 移植原型；须在 index.css 后，依赖其 token）
import './i18n'; // 导入 i18n 配置
import { ThemeProvider } from '@/components/theme-provider';

// 全局错误处理 - 渲染进程
window.addEventListener('error', (event: ErrorEvent) => {
  console.error('Renderer Error:', event.error);

  // 记录错误到日志
  const errorMessage = event.error?.message || event.message;
  const errorStack = event.error?.stack || '';
  console.error(`渲染进程错误: ${errorMessage}\n${errorStack}`);

  // 阻止默认的错误处理
  event.preventDefault();
});

window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  console.error('Renderer Unhandled Rejection:', event.reason);

  // 记录错误到日志
  const errorMessage = event.reason instanceof Error ? event.reason.message : String(event.reason);
  const errorStack = event.reason instanceof Error ? event.reason.stack : '';
  console.error(`渲染进程未处理的 Promise 拒绝: ${errorMessage}\n${errorStack}`);

  // 阻止默认的错误处理
  event.preventDefault();
});

// Add platform class immediately so CSS can be platform-aware from the first paint
const platform = window.electron?.platform || 'unknown';
document.documentElement.classList.add(`platform-${platform}`);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
