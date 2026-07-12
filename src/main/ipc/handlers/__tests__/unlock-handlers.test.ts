/**
 * unlock-handlers 单测（node env）：mock ipc-handler 的 registerIpcHandler，捕获注册的 channel→handler，
 * 断言 channel 注册齐全、透传 service 返回值、args 形状（force 缺省=false）。mock service。
 */
const registered = new Map<string, (event: unknown, args: unknown) => unknown>();
jest.mock('../../ipc-handler', () => ({
  registerIpcHandler: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
    registered.set(channel, handler);
  },
}));

import { IPC_CHANNELS } from '../../../../shared/ipc-channels';
import { registerUnlockHandlers } from '../unlock-handlers';
import type { UnlockDetectionService } from '../../../services/unlock/UnlockDetectionService';

function makeService() {
  return {
    run: jest.fn().mockResolvedValue({ results: {}, checkedAt: 1, egress: null }),
    getSnapshot: jest.fn().mockReturnValue({ results: {}, checkedAt: 2, egress: null }),
  } as unknown as UnlockDetectionService & { run: jest.Mock; getSnapshot: jest.Mock };
}

beforeEach(() => registered.clear());

describe('registerUnlockHandlers', () => {
  it('注册 UNLOCK_RUN + UNLOCK_GET 两 channel', () => {
    registerUnlockHandlers(makeService());
    expect(registered.has(IPC_CHANNELS.UNLOCK_RUN)).toBe(true);
    expect(registered.has(IPC_CHANNELS.UNLOCK_GET)).toBe(true);
    expect(registered.size).toBe(2);
  });

  it('UNLOCK_RUN 透传 force → service.run', async () => {
    const svc = makeService();
    registerUnlockHandlers(svc);
    const h = registered.get(IPC_CHANNELS.UNLOCK_RUN)!;
    await h({}, { force: true });
    expect(svc.run).toHaveBeenCalledWith(true);
  });

  it('UNLOCK_RUN args 缺省/undefined → force=false', async () => {
    const svc = makeService();
    registerUnlockHandlers(svc);
    const h = registered.get(IPC_CHANNELS.UNLOCK_RUN)!;
    await h({}, undefined);
    expect(svc.run).toHaveBeenCalledWith(false);
  });

  it('UNLOCK_GET 透传 service.getSnapshot 返回值', async () => {
    const svc = makeService();
    registerUnlockHandlers(svc);
    const h = registered.get(IPC_CHANNELS.UNLOCK_GET)!;
    const r = await h({}, undefined);
    expect(svc.getSnapshot).toHaveBeenCalled();
    expect(r).toEqual({ results: {}, checkedAt: 2, egress: null });
  });
});
