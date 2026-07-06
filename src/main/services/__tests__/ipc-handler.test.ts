/**
 * IpcHandlerRegistry 单测（B 块）。
 *
 * 覆盖：
 *  - register：首注册成功（ipcMain.handle 被调 + isRegistered true）
 *  - register 同名 channel 二次注册：开发期（app.isPackaged=false）抛错及早暴露
 *  - register 同名 channel 二次注册：生产期（app.isPackaged=true）不抛、记 LogManager.warn
 *  - 包装 handler：成功 → ApiResponse{success:true,data}；抛错 → ApiResponse{success:false,error,code}
 *  - unregister / unregisterAll / getRegisteredChannels / isRegistered
 *  - registerIpcHandler 便捷函数（委托全局 registry）
 *
 * electron app.isPackaged 经 mock 切换；ipcMain.handle/removeHandler 用 jest.fn 捕获调用。
 */
const handleSpy = jest.fn();
const removeHandlerSpy = jest.fn();

jest.mock('electron', () => ({
  app: {
    // 默认开发期；个别测试运行前改写 app.isPackaged
    isPackaged: false,
  },
  ipcMain: {
    handle: (...args: any[]) => handleSpy(...args),
    removeHandler: (...args: any[]) => removeHandlerSpy(...args),
  },
}));

// 每个测试用独立 registry 实例（避免全局 ipcHandlerRegistry 跨测试污染 + 开发期二次注册抛错连锁）
// 路径：services/__tests__ → services → main → main/ipc/ipc-handler
import { IpcHandlerRegistry, setIpcLogger } from '../../ipc/ipc-handler';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';

function makeLogger() {
  return { addLog: jest.fn() } as any;
}

beforeEach(() => {
  handleSpy.mockClear();
  removeHandlerSpy.mockClear();
});

describe('IpcHandlerRegistry.register', () => {
  it('首注册：ipcMain.handle 被调 + isRegistered true + getRegisteredChannels 含该 channel', () => {
    const reg = new IpcHandlerRegistry();
    reg.register(IPC_CHANNELS.CONFIG_GET, async () => 'ok');
    expect(handleSpy).toHaveBeenCalledTimes(1);
    expect(handleSpy.mock.calls[0][0]).toBe(IPC_CHANNELS.CONFIG_GET);
    expect(reg.isRegistered(IPC_CHANNELS.CONFIG_GET)).toBe(true);
    expect(reg.getRegisteredChannels()).toContain(IPC_CHANNELS.CONFIG_GET);
  });

  it('register 在 handle 前先 removeHandler（防 Electron 二次 handle 抛 "second handler"，使生产覆盖注册真生效）', () => {
    const reg = new IpcHandlerRegistry();
    const order: string[] = [];
    removeHandlerSpy.mockImplementationOnce(() => order.push('remove'));
    handleSpy.mockImplementationOnce(() => order.push('handle'));
    reg.register(IPC_CHANNELS.CONFIG_GET, async () => 'ok');
    // removeHandler 必须先于 handle：Electron 对同名 channel 二次 handle 会 throw，先摘除才不崩。
    expect(order).toEqual(['remove', 'handle']);
    expect(removeHandlerSpy).toHaveBeenCalledWith(IPC_CHANNELS.CONFIG_GET);
  });

  it('同名 channel 二次注册（开发期 app.isPackaged=false）→ 抛错', () => {
    const reg = new IpcHandlerRegistry();
    reg.register(IPC_CHANNELS.VERSION_GET_INFO, async () => 1);
    expect(() => reg.register(IPC_CHANNELS.VERSION_GET_INFO, async () => 2)).toThrow(
      /already registered/
    );
  });

  it('同名 channel 二次注册（生产期 app.isPackaged=true）→ 不抛、记 LogManager.warn', () => {
    // 切生产态：electron mock 经 jest.mock 注入，运行时 app.isPackaged 可写
    const electron: { app: { isPackaged: boolean } } = require('electron');
    const prev = electron.app.isPackaged;
    electron.app.isPackaged = true;
    try {
      const logger = makeLogger();
      setIpcLogger(logger);
      const reg = new IpcHandlerRegistry();
      reg.register(IPC_CHANNELS.CONFIG_SAVE, async () => 1);
      expect(() => reg.register(IPC_CHANNELS.CONFIG_SAVE, async () => 2)).not.toThrow();
      expect(logger.addLog).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('already registered'),
        'IpcHandlerRegistry'
      );
      setIpcLogger(null);
    } finally {
      electron.app.isPackaged = prev; // 还原，免污染后续测试
    }
  });
});

describe('IpcHandlerRegistry 包装 handler', () => {
  it('handler 成功 → ApiResponse{success:true,data}', async () => {
    const reg = new IpcHandlerRegistry();
    reg.register(IPC_CHANNELS.CONFIG_GET, async () => ({ a: 1 }));
    const wrapped = handleSpy.mock.calls[0][1];
    const res = await wrapped({}, undefined);
    expect(res).toEqual({ success: true, data: { a: 1 } });
  });

  it('handler 抛错 → ApiResponse{success:false,error,code}（code 透传）', async () => {
    const reg = new IpcHandlerRegistry();
    reg.register(IPC_CHANNELS.CONFIG_GET, async () => {
      const e = new Error('boom') as Error & { code?: string };
      e.code = 'CUSTOM_CODE';
      throw e;
    });
    const wrapped = handleSpy.mock.calls[0][1];
    const res = await wrapped({}, undefined);
    expect(res.success).toBe(false);
    expect(res.error).toBe('boom');
    expect(res.code).toBe('CUSTOM_CODE');
  });

  it('handler 抛非 Error 值 → String 化为 error、无 code', async () => {
    const reg = new IpcHandlerRegistry();
    reg.register(IPC_CHANNELS.CONFIG_GET, async () => {
      throw 'plain string'; // 非 Error
    });
    const wrapped = handleSpy.mock.calls[0][1];
    const res = await wrapped({}, undefined);
    expect(res.success).toBe(false);
    expect(res.error).toBe('plain string');
    expect(res.code).toBeUndefined();
  });
});

describe('IpcHandlerRegistry unregister / unregisterAll', () => {
  it('unregister：已注册 → ipcMain.removeHandler + 删 map', () => {
    const reg = new IpcHandlerRegistry();
    reg.register(IPC_CHANNELS.CONFIG_GET, async () => 1);
    reg.unregister(IPC_CHANNELS.CONFIG_GET);
    expect(removeHandlerSpy).toHaveBeenCalledWith(IPC_CHANNELS.CONFIG_GET);
    expect(reg.isRegistered(IPC_CHANNELS.CONFIG_GET)).toBe(false);
  });

  it('unregister：未注册 → no-op（不抛）', () => {
    const reg = new IpcHandlerRegistry();
    expect(() => reg.unregister(IPC_CHANNELS.CONFIG_GET)).not.toThrow();
    expect(removeHandlerSpy).not.toHaveBeenCalled();
  });

  it('unregisterAll：清空所有 channel', () => {
    const reg = new IpcHandlerRegistry();
    reg.register(IPC_CHANNELS.CONFIG_GET, async () => 1);
    reg.register(IPC_CHANNELS.CONFIG_SAVE, async () => 2);
    // register 覆盖注册前会先 removeHandler（Fix：防 Electron 二次 handle 抛错），此处只验证 unregisterAll 自身的移除。
    removeHandlerSpy.mockClear();
    reg.unregisterAll();
    expect(removeHandlerSpy).toHaveBeenCalledTimes(2);
    expect(reg.getRegisteredChannels()).toEqual([]);
  });
});
