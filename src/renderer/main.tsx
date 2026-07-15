import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './assets/fonts/fonts.css';
import './index.css';
import './conduit.css'; // Conduit 设计系统（1:1 移植原型；须在 index.css 后，依赖其 token）
import './i18n'; // 导入 i18n 配置
import { ThemeProvider } from '@/components/theme-provider';
import { ErrorBoundary } from './components/error-boundary';
import { IPC_CHANNELS } from '../shared/ipc-channels';

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

// GAP-1b 根级 ErrorBoundary 的静态 fallback：**不依赖 i18n/theme**。原 App.tsx:158 的 ErrorBoundary 在 App 返回值
// 内部，护不住 App 函数体的 hooks（useAppStore/useNativeEventListeners）与本文件 ThemeProvider 的 render 抛错——
// 那些正是 C 类白屏的高发点。故在此把 ErrorBoundary 上提到 ThemeProvider 之外的最外层。fallback 用纯内联样式
// （i18n/theme 本身可能是坏的那一环，故不走 react-i18next / 主题 CSS 变量），保证「无论哪层坏都能看到反馈 + 一键重载」。
// L2：fallback 是**组件**（非静态元素），挂上时发一次 RENDERER_READY——renderer 活着且在显示可交互兜底 UI，据此让
// 主进程健康门视为「已就绪」，抑制终局 dialog 升级（用户已有可交互 fallback + 「重新加载」按钮，再叠 modal 是冗余）。
// 允许门此前的一次自动 reload（可能治瞬态）；本信号只阻断终局升级。按钮 location.reload() 在真实应用页有效（非 data:）。
/* eslint-disable no-restricted-syntax -- 末路 fallback 刻意用裸 hex 内联样式：此页在 theme/CSS token 已证实起不来时
   渲染，绝不能依赖 Conduit token / CSS 变量（那正可能是坏的一环）。色值与主窗 backgroundColor 同系。 */
function RootErrorFallback() {
  useEffect(() => {
    window.electron?.ipcRenderer?.invoke(IPC_CHANNELS.RENDERER_READY).catch(() => {});
  }, []);
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: 24,
        background: '#1F252E',
        color: '#E6EDF3',
        fontFamily: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
      }}
    >
      <div style={{ maxWidth: 520 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 12px' }}>
          界面初始化失败 / Failed to initialize
        </h1>
        <p style={{ fontSize: 13, lineHeight: 1.6, color: '#9DA7B3', margin: '0 0 20px' }}>
          界面加载遇到问题，请尝试重新加载。/ The interface failed to load. Please try reloading.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            font: 'inherit',
            fontSize: 13,
            color: '#fff',
            background: '#2F81F7',
            border: 0,
            borderRadius: 8,
            padding: '9px 20px',
            cursor: 'pointer',
          }}
        >
          重新加载 / Reload
        </button>
      </div>
    </div>
  );
}
/* eslint-enable no-restricted-syntax */

/**
 * GAP-1b mount 自护：createRoot().render() 的**同步**早期抛错（render 调用栈内同步 throw，未进 React 提交阶段）
 * 的最后一道防线——向 #root 注入纯静态 DOM（不依赖 React/i18n/theme）+ console.error（经主进程 console-message
 * 转发捕获，见 index.ts GAP-1c）。分工：React concurrent render 的错误是异步浮出、由根级 ErrorBoundary 兜（不进此
 * catch）；模块级 import 抛错（本文件根本没跑起来）由主进程健康门（GAP-1a 超时）兜。此处只兜同步 render 抛错，
 * 避免只剩纯背景色空窗。
 */
function injectStaticFailureDom(root: HTMLElement, err: unknown): void {
  // console.error 供主进程 console-message 转发捕获（GAP-1c），是此路径唯一可观测信号。
  console.error('Renderer mount failed (createRoot.render threw):', err);
  root.innerHTML =
    '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box;background:#1F252E;color:#E6EDF3;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">' +
    '<div style="max-width:520px">' +
    '<h1 style="font-size:18px;font-weight:600;margin:0 0 12px">界面初始化失败 / Failed to initialize</h1>' +
    '<p style="font-size:13px;line-height:1.6;color:#9DA7B3;margin:0 0 20px">界面加载遇到问题，请尝试重新加载。/ The interface failed to load. Please try reloading.</p>' +
    '<button type="button" onclick="location.reload()" style="font-size:13px;color:#fff;background:#2F81F7;border:0;border-radius:8px;padding:9px 20px;cursor:pointer">重新加载 / Reload</button>' +
    '</div></div>';
}

const rootEl = document.getElementById('root');
if (rootEl) {
  try {
    ReactDOM.createRoot(rootEl).render(
      <React.StrictMode>
        <ErrorBoundary fallback={<RootErrorFallback />}>
          <ThemeProvider>
            <App />
          </ThemeProvider>
        </ErrorBoundary>
      </React.StrictMode>
    );
  } catch (err) {
    injectStaticFailureDom(rootEl, err);
  }
}
