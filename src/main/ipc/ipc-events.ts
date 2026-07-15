import { BrowserWindow, WebContents } from 'electron';

export class IpcEventEmitter {
  private windows: Set<BrowserWindow> = new Set();

  registerWindow(window: BrowserWindow): void {
    this.windows.add(window);

    window.on('closed', () => {
      this.windows.delete(window);
    });
  }

  unregisterWindow(window: BrowserWindow): void {
    this.windows.delete(window);
  }

  sendToAll<T = any>(channel: string, data: T): void {
    for (const window of this.windows) {
      if (!window.isDestroyed() && window.webContents) {
        window.webContents.send(channel, data);
      }
    }
  }

  sendToWindow<T = any>(window: BrowserWindow, channel: string, data: T): void {
    if (!window.isDestroyed() && window.webContents) {
      window.webContents.send(channel, data);
    }
  }

  sendToWebContents<T = any>(webContents: WebContents, channel: string, data: T): void {
    if (!webContents.isDestroyed()) {
      webContents.send(channel, data);
    }
  }

  getWindowCount(): number {
    return this.windows.size;
  }

  clear(): void {
    this.windows.clear();
  }
}

export const ipcEventEmitter = new IpcEventEmitter();

export function broadcastEvent<T = any>(channel: string, data: T): void {
  ipcEventEmitter.sendToAll(channel, data);
}
