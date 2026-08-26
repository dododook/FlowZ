/**
 * B1：wintun 释放门「首腿并行预热 + 每腿必过」的接线单测。
 *
 * 门的语义一字未改（issue #159：**每一次** start 尝试、含 retry 每轮都必须按本名探测过才放行；fail-open）。
 * 本批只改首腿的**付款时机**——把那次 ~950ms 的 PowerShell 提前到 killOrphans 之后与配置生成并行跑。
 * 会被误改坏的正是这两条，故逐条钉住：
 *  1. 首腿吃预热结果，且**取走即置 null**（一次性）；
 *  2. 重试腿 pending 已空 → **现场重探**（绝不吃首腿的陈旧结论——残留是「当下」的事实）。
 *
 * 私有方法/字段经 `(svc as any)` 直调注入，不启动 sing-box。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-b1gate-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ProxyManager } from '../ProxyManager';
import { withPlatformAsync } from './platform-test-utils';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/**
 * 构造一个「走到释放门就收工」的实例：helper 就绪 + startViaHelper 桩化，使 startSingBoxProcess 在门之后
 * 立刻返回，不触碰进程/网卡/PowerShell。
 */
function makeSvc(mode: 'tun' | 'systemProxy' = 'tun'): any {
  const configPath = path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`);
  const svc: any = new ProxyManager(undefined, undefined, configPath, '/fake/sing-box');
  svc.currentConfig = { proxyModeType: mode, servers: [], selectedServerId: 'x', tunConfig: {} };
  svc.helperManager = { isReady: jest.fn().mockResolvedValue(true) };
  svc.startViaHelper = jest.fn().mockResolvedValue(undefined);
  svc.waitForOwnTunAdapterReleased = jest.fn().mockResolvedValue(undefined);
  return svc;
}

describe('B1 — 释放门首腿预热的一次性消费', () => {
  it('首腿必须 await 预热腿：预热未兑现前不得起核', async () => {
    await withPlatformAsync('win32', async () => {
      const svc = makeSvc();
      // 判据必须立在**顺序**上，不能立在终值上。曾写成 `let warmed=false; pending=Promise.resolve().then(()=>warmed=true)`
      // 再断言 `warmed===true`——那是无牙的：`.then` 的回调在微任务里自行执行，与本腿有没有 await 它毫无关系，
      // 且门之后还有 `await helperManager.isReady()` 让出一次微任务，故把整条门删掉该断言照样绿（A 面复审实测）。
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      svc.pendingAdapterReleaseGate = gate;

      const p = svc.startSingBoxProcess(svc.lifecycleGeneration ?? 0);
      await Promise.resolve(); // 让出几轮微任务：若门被删，起核此刻就已发生
      await Promise.resolve();
      expect(svc.startViaHelper).not.toHaveBeenCalled(); // ← 真正的判据：门未放行前不得起核

      release();
      await p;

      expect(svc.startViaHelper).toHaveBeenCalled(); // 门放行后才起核
      expect(svc.waitForOwnTunAdapterReleased).not.toHaveBeenCalled(); // 首腿零重探
      expect(svc.pendingAdapterReleaseGate).toBeNull(); // 一次性
    });
  });

  it('重试腿（pending 已空）现场重探——绝不复用首腿结论', async () => {
    await withPlatformAsync('win32', async () => {
      const svc = makeSvc();
      svc.pendingAdapterReleaseGate = Promise.resolve();

      await svc.startSingBoxProcess(0); // 首腿：吃预热
      await svc.startSingBoxProcess(0); // 重试腿：应现场重探
      await svc.startSingBoxProcess(0); // 再一腿：仍重探

      expect(svc.waitForOwnTunAdapterReleased).toHaveBeenCalledTimes(2);
    });
  });

  it('无预热（pending 本就为 null）→ 首腿也现场重探，行为等同改动前', async () => {
    await withPlatformAsync('win32', async () => {
      const svc = makeSvc();
      expect(svc.pendingAdapterReleaseGate).toBeNull();

      await svc.startSingBoxProcess(0);

      expect(svc.waitForOwnTunAdapterReleased).toHaveBeenCalledTimes(1);
    });
  });

  // 非 TUN / 非 Windows 走不到 helper 支路，会一路落到直起分支；核路径是假的 → 以「找不到可执行文件」收尾。
  // 那正是本用例要的：证明**门没跑**，而不是证明起核成功。
  it('非 TUN 模式：门整条不跑，预热字段不被消费', async () => {
    await withPlatformAsync('win32', async () => {
      const svc = makeSvc('systemProxy');
      svc.ensureLinuxTunCapabilities = jest.fn().mockResolvedValue(undefined);
      const sentinel = Promise.resolve();
      svc.pendingAdapterReleaseGate = sentinel;

      await expect(svc.startSingBoxProcess(0)).rejects.toThrow(/找不到 sing-box/);

      expect(svc.waitForOwnTunAdapterReleased).not.toHaveBeenCalled();
      expect(svc.pendingAdapterReleaseGate).toBe(sentinel);
    });
  });

  it('非 Windows：门整条不跑（macOS/Linux 零改动）', async () => {
    await withPlatformAsync('darwin', async () => {
      const svc = makeSvc();
      svc.needsOsascript = () => false; // 不走 mac 提权支路，直接落到下方直起判定
      svc.ensureLinuxTunCapabilities = jest.fn().mockResolvedValue(undefined);
      const sentinel = Promise.resolve();
      svc.pendingAdapterReleaseGate = sentinel;

      await expect(svc.startSingBoxProcess(0)).rejects.toThrow(/找不到 sing-box/);

      expect(svc.waitForOwnTunAdapterReleased).not.toHaveBeenCalled();
      expect(svc.pendingAdapterReleaseGate).toBe(sentinel);
    });
  });
});

/**
 * B1 另外两条不变量在 `startInternal` 层，上面那组用例（直调 `startSingBoxProcess`）够不到它们——
 * A 面复审实测：把 arm 整块上移到 killOrphans 之前、以及删掉入口清除那行，在补这组之前都是 **0 红**。
 *
 * 手法：让 arm **之后**的第一步（`copyRuleSetsToUserData`）抛一个哨兵错误，从而在不碰配置生成/起核的前提下
 * 走完 arm 及其之前的全部前置步骤。
 *
 * 注意 arm 的位置本身是被复审改过的（原在 `selectedServerId` 校验之前 → 早退分支会留下无人 await 的孤儿轮询），
 * 故这里用 `__direct__` 让两处早退校验都通过，停靠点取 arm 的紧后一步——停靠点必须跟着 arm 走，
 * 否则这条门会在 arm 再次搬家时静默失效（变成「arm 根本没执行」也能绿）。
 */
function stubPrelude(svc: any, order: string[]): void {
  svc.getSingBoxPath = () => '/fake/sing-box';
  svc.maybePromptHelperGate = jest.fn().mockResolvedValue(undefined);
  svc.killOrphanedSingBoxProcesses = jest.fn(async () => {
    order.push('killOrphans');
  });
  svc.resolveClashApiPortConflict = jest.fn().mockResolvedValue(undefined);
  svc.getCoreVersion = jest.fn().mockResolvedValue('1.14.0');
  svc.reconcileCoreWithBundledBaseline = jest.fn().mockResolvedValue(undefined);
  svc.resolveTailscaleApiPort = jest.fn().mockResolvedValue(9099);
  svc.fixFilePermissions = jest.fn().mockResolvedValue(undefined);
  svc.startTunAddressPreflight = jest.fn().mockResolvedValue(null);
  svc.waitForOwnTunAdapterReleased = jest.fn(async () => {
    order.push('armGate');
  });
  // arm 的紧后一步：抛哨兵停下。同时它自己也进 order —— 若 arm 被搬到它之后，顺序断言会直接翻红。
  svc.copyRuleSetsToUserData = jest.fn(async () => {
    order.push('afterArm');
    throw new Error('STOP_AFTER_ARM');
  });
  svc.logToManager = jest.fn();
  // 经 public start() 进入（埋点收集器在那儿建），故失败收口的两步要桩掉，免得碰进程/系统代理。
  svc.cleanup = jest.fn();
  svc.ensureSystemProxyCleared = jest.fn().mockResolvedValue(undefined);
}

/** `__direct__` 让 selectedServerId / selectedServer 两处早退都通过，走到 arm。 */
const DIRECT_CFG: any = {
  proxyModeType: 'tun',
  servers: [],
  selectedServerId: '__direct__',
  tunConfig: {},
};

describe('B1 — startInternal 层的两条不变量', () => {
  it('arm 必须发生在 killOrphans 之后：孤儿被硬杀才是适配器开始释放的起点', async () => {
    await withPlatformAsync('win32', async () => {
      const svc = makeSvc();
      const order: string[] = [];
      stubPrelude(svc, order);

      await expect(svc.start(DIRECT_CFG)).rejects.toThrow(/STOP_AFTER_ARM/);

      // 变异守卫：把 arm 那块上移到 killOrphans 之前 → 顺序翻转 → 红；arm 被删/搬到停靠点之后 → 缺项 → 红
      expect(order).toEqual(['killOrphans', 'armGate', 'afterArm']);

      // 顺带钉住 B0 埋点的**生产路径**（复审 Low）：此前 25 处 markStart + beginLeg 全无断言——
      // `proxy-manager-start-timeline.test.ts` 把 startInternal 整个桩掉，验的是被调函数而不是调用点。
      // 这里真跑了一遍前置链路，那些格必须出现在汇总行里。
      const summary = svc.getLastStartTimeline() as string;
      expect(summary).toContain('outcome=failed');
      for (const label of ['stopOld=', 'helperGate=', 'killOrphans=', 'coreVersion=', 'apiPort=']) {
        expect(summary).toContain(label);
      }
    });
  });

  it('startInternal 入口清掉上一次 start 遗留的预热（否则下一次首腿吃陈旧结论）', async () => {
    // 非 Windows 跑：入口清除是无条件的，而 arm 有 win32 守卫 → 清完不会被重新 arm，
    // 故「结束时为 null」这一条只可能来自入口那次清除。
    await withPlatformAsync('darwin', async () => {
      const svc = makeSvc();
      stubPrelude(svc, []);
      const stale = Promise.resolve();
      svc.pendingAdapterReleaseGate = stale; // 模拟上一次 start 在首腿之前抛错留下的遗留

      await expect(svc.start(DIRECT_CFG)).rejects.toThrow(/STOP_AFTER_ARM/);

      // 变异守卫：删掉入口那行 `this.pendingAdapterReleaseGate = null` → 这里仍是 stale → 红
      expect(svc.pendingAdapterReleaseGate).toBeNull();
    });
  });
});
