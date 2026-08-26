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

/**
 * B4：就绪节拍与探活节拍解耦。把 pollMs 调细（500→50）是为了少空等，但探活是子进程
 * （Windows `tasklist` ~50-100ms），若跟着细节拍走就是拿一个开销换一个更大的开销。
 */
describe('waitForCoreReady — alivePollMs 双节拍（B4）', () => {
  /** 第 n 次调用才 ready 的桩（n 从 1 计）。 */
  function readyAt(n: number): { isReady: () => Promise<boolean>; calls: () => number } {
    let c = 0;
    return {
      isReady: async () => ++c >= n,
      calls: () => c,
    };
  }

  it('缺省 alivePollMs = pollMs → 每轮探活（改动前行为逐字保持）', async () => {
    let aliveCalls = 0;
    const ready = readyAt(4);
    const r = await waitForCoreReady(
      { timeoutMs: 12000, pollMs: 500 },
      {
        isAlive: () => {
          aliveCalls++;
          return true;
        },
        isReady: ready.isReady,
        sleep: noSleep,
      }
    );
    expect(r).toBe('ready');
    // 前 3 轮 isReady 假 → 各探活一次；第 4 轮 ready 早退（不探活）
    expect(aliveCalls).toBe(3);
  });

  it('alivePollMs=500 / pollMs=50 → 每 10 轮探一次活，且首轮必探（瞬死检出不变差）', async () => {
    let aliveCalls = 0;
    const ready = readyAt(21); // 前 20 轮不 ready
    const r = await waitForCoreReady(
      { timeoutMs: 12000, pollMs: 50, alivePollMs: 500 },
      {
        isAlive: () => {
          aliveCalls++;
          return true;
        },
        isReady: ready.isReady,
        sleep: noSleep,
      }
    );
    expect(r).toBe('ready');
    // i=0 与 i=10 两轮探活（i=20 那轮 isReady 已真、早退）——而非 20 次
    expect(aliveCalls).toBe(2);
  });

  it('细节拍让就绪检出更快：ready 出现在第 3 轮 → 只 sleep 2 次', async () => {
    let sleeps = 0;
    const ready = readyAt(3);
    const r = await waitForCoreReady(
      { timeoutMs: 12000, pollMs: 50, alivePollMs: 500 },
      {
        isAlive: () => true,
        isReady: ready.isReady,
        sleep: async () => {
          sleeps++;
        },
      }
    );
    expect(r).toBe('ready');
    expect(sleeps).toBe(2);
  });

  it('异步 isAlive 被 await：循环内首轮即判 dead，不是耗尽预算后靠末轮兜底', async () => {
    // 只断言 outcome='dead' 挡不住「忘了 await」——Promise 恒真值 → 循环里永不 dead，但**末轮**那次判定
    // 仍是 await 的，最终照样返回 dead。故判据必须是「多快判出来」：真 await 时首轮即退，一次 sleep 都没有。
    let sleeps = 0;
    const r = await waitForCoreReady(
      { timeoutMs: 1000, pollMs: 50, alivePollMs: 500 },
      {
        isAlive: async () => false,
        isReady: async () => false,
        sleep: async () => {
          sleeps++;
        },
      }
    );
    expect(r).toBe('dead');
    expect(sleeps).toBe(0);
  });

  it('alivePollMs 小于 pollMs 时被夹到 pollMs（不产生「每轮探多次」的荒谬节拍）', async () => {
    let aliveCalls = 0;
    const ready = readyAt(3);
    await waitForCoreReady(
      { timeoutMs: 12000, pollMs: 500, alivePollMs: 10 },
      {
        isAlive: () => {
          aliveCalls++;
          return true;
        },
        isReady: ready.isReady,
        sleep: noSleep,
      }
    );
    expect(aliveCalls).toBe(2);
  });
});

/**
 * B4 复审 Med：`maxPolls` 只是轮数封顶，`timeoutMs` 必须是**时间**预算。原有 5 条用例全部注入 no-op sleep、
 * 断言的是轮数与调用次数，破坏墙钟这一维（如把 maxPolls 乘 10）是 0 红。此处用计账式时钟把预算本身立成判据。
 */
describe('waitForCoreReady — timeoutMs 是时间预算而非轮数（B4）', () => {
  /** 计账式时钟：sleep 与探测各自把耗时累加进虚拟时间，`now` 读它。 */
  function accountant(opts: { probeMs: number }) {
    let t = 0;
    return {
      now: (): number => t,
      sleep: async (ms: number): Promise<void> => {
        t += ms;
      },
      isReady: async (): Promise<boolean> => {
        t += opts.probeMs; // 模拟 probeTcpReachable 的真实成本（自带 1000ms 上限）
        return false;
      },
      elapsed: (): number => t,
    };
  }

  it('每轮探测远超 pollMs 时，仍在 timeoutMs 附近收口（不按轮数超支）', async () => {
    // 复审实测的病态场景：connect 打满 1000ms、pollMs=50 → 按轮数会跑到 ~255s
    const acc = accountant({ probeMs: 1000 });
    const r = await waitForCoreReady(
      { timeoutMs: 12000, pollMs: 50, alivePollMs: 500 },
      { isAlive: () => true, isReady: acc.isReady, sleep: acc.sleep, now: acc.now }
    );
    expect(r).toBe('timeout');
    // 变异守卫：去掉 `now() < deadline` 判据 → elapsed 会跑到 ~250s → 红
    expect(acc.elapsed()).toBeLessThanOrEqual(12000 * 1.2);
  });

  it('探测很便宜时预算同样成立（不因 deadline 改造而提前收口）', async () => {
    const acc = accountant({ probeMs: 1 });
    const r = await waitForCoreReady(
      { timeoutMs: 12000, pollMs: 50, alivePollMs: 500 },
      { isAlive: () => true, isReady: acc.isReady, sleep: acc.sleep, now: acc.now }
    );
    expect(r).toBe('timeout');
    expect(acc.elapsed()).toBeGreaterThan(12000 * 0.8);
    expect(acc.elapsed()).toBeLessThanOrEqual(12000 * 1.2);
  });

  it('不注入 now 时退化为轮数封顶（既有注入式用例行为不变）', async () => {
    let polls = 0;
    const r = await waitForCoreReady(
      { timeoutMs: 1000, pollMs: 250 },
      {
        isAlive: () => true,
        isReady: async () => {
          polls++;
          return false;
        },
        sleep: noSleep,
      }
    );
    expect(r).toBe('timeout');
    expect(polls).toBe(5); // 4 轮 + 末轮补探
  });
});
