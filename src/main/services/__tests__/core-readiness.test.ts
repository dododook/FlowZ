/**
 * core-readiness 就绪门控单测（issue #159 纵深网）。
 * waitForCoreReady 注入 isAlive/isReady/sleep（零真实进程/计时器）；probeTcpReachable 用真实 net.Server 验通断。
 */
import { createServer, type AddressInfo } from 'net';
import { waitForCoreReady, probeTcpReachable } from '../core-readiness';

const noSleep = async (): Promise<void> => {};

describe('waitForCoreReady', () => {
  it('API 即可连 → ready，且不触发 isAlive（execSync 探活）阻塞（成功路径零阻塞）', async () => {
    let aliveCalls = 0;
    const r = await waitForCoreReady(
      { timeoutMs: 12000, pollMs: 500 },
      {
        isAlive: () => {
          aliveCalls++;
          return true;
        },
        isReady: async () => true,
        sleep: noSleep,
      }
    );
    expect(r).toBe('ready');
    expect(aliveCalls).toBe(0); // isReady 先判、即就绪 → 从不调用阻塞探活
  });

  it('进程已死 → dead（即时捕获，不等满超时）', async () => {
    const r = await waitForCoreReady(
      { timeoutMs: 12000, pollMs: 300 },
      { isAlive: () => false, isReady: async () => false, sleep: noSleep }
    );
    expect(r).toBe('dead');
  });

  it('数轮后 API 绑定 → ready', async () => {
    let n = 0;
    const r = await waitForCoreReady(
      { timeoutMs: 12000, pollMs: 300 },
      { isAlive: () => true, isReady: async () => ++n >= 3, sleep: noSleep }
    );
    expect(r).toBe('ready');
    expect(n).toBe(3);
  });

  it('进程活但 API 始终不绑 → timeout', async () => {
    const r = await waitForCoreReady(
      { timeoutMs: 900, pollMs: 300 },
      { isAlive: () => true, isReady: async () => false, sleep: noSleep }
    );
    expect(r).toBe('timeout');
  });

  it('就绪前进程死 → dead（不误判 timeout）', async () => {
    let alive = true;
    let polls = 0;
    const r = await waitForCoreReady(
      { timeoutMs: 12000, pollMs: 300 },
      {
        isAlive: () => alive,
        isReady: async () => false,
        sleep: async () => {
          if (++polls >= 2) alive = false;
        },
      }
    );
    expect(r).toBe('dead');
  });
});

describe('probeTcpReachable', () => {
  it('监听端口 → true；关闭后 → false', async () => {
    const srv = createServer();
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as AddressInfo).port));
    });
    expect(await probeTcpReachable('127.0.0.1', port, 1000)).toBe(true);
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await probeTcpReachable('127.0.0.1', port, 500)).toBe(false);
  });
});
