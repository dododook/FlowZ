/**
 * core-readiness 就绪门控单测（issue #159 纵深网）。
 * waitForCoreReady 注入 isAlive/isReady/sleep（零真实进程/计时器）；probeTcpReachable 用真实 net.Server 验通断。
 */
import { createServer, type AddressInfo } from 'net';
import {
  waitForCoreReady,
  probeTcpReachable,
  startMessageIsNonRetryable,
  CoreStartRetryError,
  CoreStartTunPersistentError,
} from '../core-readiness';

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

  // issue #176：被更新的 start/stop 接管 → superseded，且优先于 ready/dead/timeout，不触发 isReady/isAlive。
  it('已被接管 → superseded（优先于一切，零 isReady/isAlive 调用）', async () => {
    let readyCalls = 0;
    let aliveCalls = 0;
    const r = await waitForCoreReady(
      { timeoutMs: 12000, pollMs: 300 },
      {
        isAlive: () => {
          aliveCalls++;
          return true;
        },
        isReady: async () => {
          readyCalls++;
          return true;
        },
        sleep: noSleep,
        isSuperseded: () => true,
      }
    );
    expect(r).toBe('superseded');
    expect(readyCalls).toBe(0);
    expect(aliveCalls).toBe(0);
  });

  it('等待中途被接管 → superseded（不再误判 timeout/ready）', async () => {
    let superseded = false;
    let polls = 0;
    const r = await waitForCoreReady(
      { timeoutMs: 12000, pollMs: 300 },
      {
        isAlive: () => true,
        isReady: async () => false,
        sleep: async () => {
          if (++polls >= 2) superseded = true;
        },
        isSuperseded: () => superseded,
      }
    );
    expect(r).toBe('superseded');
  });
});

// issue #324：持续性 TUN 失败终态标记错误——独立类型，走 instanceof（不进 nonRetryableErrors 词表），非 CoreStartRetryError 子类。
describe('CoreStartTunPersistentError (issue #324)', () => {
  it('携默认可操作诊断文案，且与 CoreStartRetryError 互不 instanceof', () => {
    const e = new CoreStartTunPersistentError();
    expect(e).toBeInstanceOf(CoreStartTunPersistentError);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(CoreStartRetryError); // 终态类 ≠ 可重试类：instanceof 判别不误重试
    expect(new CoreStartRetryError('x')).not.toBeInstanceOf(CoreStartTunPersistentError);
    expect(e.name).toBe('CoreStartTunPersistentError');
    expect(e.message).toMatch(/wintun|TUN 适配器/); // 携指向 wintun/适配器的可操作提示
  });

  it('接受自定义文案', () => {
    expect(new CoreStartTunPersistentError('自定义').message).toBe('自定义');
  });
});

// review Low#5：起核 retry 词表判据守卫——issue #324 A1/A3 新增 CoreStartRetryError 文案必须**不**命中 nonRetryable 词表
// （否则可重试文案被静默判为不可重试），且既有黑名单词照常命中（防未来加词漂移）。
describe('startMessageIsNonRetryable (issue #176/#324 retry 词表守卫)', () => {
  it('#324 A1「TUN 适配器未建立」文案 → 可重试（不命中词表）', () => {
    expect(
      startMessageIsNonRetryable('sing-box 已就绪但 TUN 适配器 flowz-tun0 未建立，正在自动重试')
    ).toBe(false);
  });
  it('#324 A3「TUN 适配器从未创建」文案 → 可重试', () => {
    expect(
      startMessageIsNonRetryable(
        'sing-box 启动期退出（TUN 适配器从未创建，疑 wintun 被拦/驱动异常），正在自动重试'
      )
    ).toBe(false);
  });
  it('既有「TUN 初始化未完成」dead 文案 → 可重试（不回归）', () => {
    expect(
      startMessageIsNonRetryable('sing-box 启动期退出（TUN 初始化未完成），正在自动重试')
    ).toBe(false);
  });
  it('黑名单词照常命中不可重试（权限/找不到/坏配置，大小写不敏感）', () => {
    expect(startMessageIsNonRetryable('管理员权限被拒绝')).toBe(true);
    expect(startMessageIsNonRetryable('文件找不到')).toBe(true);
    expect(startMessageIsNonRetryable('Invalid Config: bad field')).toBe(true); // 大写也命中
    expect(startMessageIsNonRetryable('EACCES: permission denied')).toBe(true);
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
