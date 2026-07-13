/**
 * preload-update-popup.ts — 独立更新弹窗窗口的 preload（UpdateService.createUpdatePopup）。
 *
 * contextIsolation:true → 经 contextBridge 暴露最小 API：接主进程推送的四态状态载荷 + 回传按钮/关闭动作。
 * 不引 React、不暴露 Node/其它 ipc。编译入 dist/main/main/preload-update-popup.js（rootDir=src / outDir=dist/main，
 * 与 dashboard-preload 同路径规律）。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type { UpdatePopupState, UpdatePopupAction } from '../shared/types/update';

// 界面语言注入（主进程 additionalArguments `--flowz-popup-lang=<code>`）：据此设 <html lang/dir>，
// 修弹窗页 lang 写死 zh-CN（fa 需 rtl）。DOMContentLoaded 后设，覆盖 HTML 静态 lang 属性。
const LANG_PREFIX = '--flowz-popup-lang=';
const langArg = process.argv.find((a) => a.startsWith(LANG_PREFIX));
if (langArg) {
  const code = langArg.slice(LANG_PREFIX.length);
  const applyLang = () => {
    const el = (globalThis as { document?: { documentElement?: { lang: string; dir: string } } })
      .document?.documentElement;
    if (!el || !code) return;
    el.lang = code;
    el.dir = code === 'fa' ? 'rtl' : 'ltr';
  };
  const doc = (
    globalThis as {
      document?: { readyState: string; addEventListener: (t: string, cb: () => void) => void };
    }
  ).document;
  if (doc && doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', applyLang);
  else applyLang();
}

contextBridge.exposeInMainWorld('flowzUpdatePopup', {
  /** 订阅主进程推送的状态载荷；返回退订函数。 */
  onState(cb: (state: UpdatePopupState) => void): () => void {
    const listener = (_e: IpcRendererEvent, state: UpdatePopupState) => cb(state);
    ipcRenderer.on(IPC_CHANNELS.UPDATE_POPUP_STATE, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_POPUP_STATE, listener);
  },
  /** 回传按钮/关闭动作到主进程。 */
  sendAction(action: UpdatePopupAction): void {
    ipcRenderer.send(IPC_CHANNELS.UPDATE_POPUP_ACTION, action);
  },
});
