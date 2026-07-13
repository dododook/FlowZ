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
