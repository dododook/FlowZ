/**
 * A7 run-phase 备用腿单测（补覆盖审查 P2 #6）：
 *
 * 覆盖 start() → startInternal() 里传给 retry(startSingBoxProcess) 的 shouldRetry / onRetry 两个内联闭包，
 * 对 run 阶段 `dependency[X] not found` FATAL 的处理：
 *  - shouldRetry：dependency-not-found 错误 → 返 `!refFixAttempted`（首次允许重试，置闸后不再重试）。
 *  - onRetry：解析幽灵 tag → pruneTagsClosure(cfg, config, {tag}, 'detour') 修正重写盘；refFixAttempted 置 true（单次闸）。
 *  - 单次闸语义：startSingBoxProcess 连续两次抛同类错误 → 只触发一次 onRetry（pruneTagsClosure 调一次）、
 *    第二次 shouldRetry 因 refFixAttempted=true 返 false → 不再重试，最终错误冒泡。
 *
 * 方式：option ①「不改生产逻辑，spy/构造触发」。retry 的两个回调是内联闭包不可独立调用，故经 public start()
 * 真实跑 startInternal → retry：stub 全部前置生命周期协作方为 no-op、stub startSingBoxProcess 抛
 * `dependency[ghost] not found` 触发回调；用 jest fake timers 跳过 retry 的 2s/4s 退避。onRetry 在首个 await
 * 前同步调用 generateSingBoxConfig + pruneTagsClosure，故 spy 可同步断言，无需等其 fire-and-forget 异步落盘。
 * 不改任何生产逻辑、不抽取。
 */
import * as os from 'os';
import * as fsSync from 'fs';
import * as path from 'path';

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-runfix-test-'));
jest.mock('electron', () => ({
  app: {
    getPath: () => TMP,
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => TMP,
  },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ProxyManager } from '../ProxyManager';
import type { UserConfig } from '../../../shared/types';

type Any = any;

/** 最小可启动 UserConfig：选中 sel，含一个节点；细节不重要——前置生命周期协作方全部被 stub。 */
function makeConfig(): UserConfig {
  return {
    servers: [{ id: 'sel', name: 'SEL', protocol: 'vless', address: 'a.example.com', port: 443 }],
    selectedServerId: 'sel',
    proxyMode: 'smart',
    proxyModeType: 'tun',
    appRules: [],
  } as Any;
}

/**
 * 造一个 ProxyManager，把 startInternal 里 retry(startSingBoxProcess) 之前的全部前置步骤 stub 成 no-op，
 * 并 stub start()/catch 收口的 cleanup/ensureSystemProxyCleared，使测试只聚焦 retry 的 shouldRetry/onRetry。
 * 返回各关键 spy 供断言。
 */
function makePm() {
  const configPath = path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`);
  const pm: Any = new ProxyManager(undefined, undefined, configPath, '/fake/sing-box');
  pm.logToManager = () => {};
  pm.sendEventToRenderer = () => {};

  // —— retry 之前的前置生命周期，全部 stub 成 no-op（不改逻辑，仅隔离被测闭包）——
  const noop = async () => {};
  for (const m of [
    'maybePromptHelperGate',
    'killOrphanedSingBoxProcesses',
    'resolveClashApiPortConflict',
    'fixFilePermissions',
    'copyRuleSetsToUserData',
    'writeCustomRuleFiles',
    'allocateProbePorts',
    'writeSingBoxConfig',
    'checkAndPruneConfig',
    'ensureSystemProxyCleared',
  ]) {
    jest.spyOn(pm, m).mockImplementation(noop);
  }
  jest.spyOn(pm, 'getCoreVersion').mockResolvedValue('1.99.0');
  jest.spyOn(pm, 'cleanup').mockImplementation(() => {});
  jest.spyOn(pm, 'resetRestartCount').mockImplementation(() => {});
  // generateSingBoxConfig：startInternal 主路径 + onRetry 都会调；返最小可被 pruneTagsClosure 处理的配置。
  const genConfig = () => ({
    log: { level: 'info' },
    inbounds: [],
    outbounds: [
      { type: 'vless', tag: 'GHOST' },
      { type: 'selector', tag: 'proxy-selector', outbounds: ['GHOST'], default: 'GHOST' },
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
    ],
    route: { rules: [] },
  });
  jest.spyOn(pm, 'generateSingBoxConfig').mockImplementation(genConfig);
  // pruneTagsClosure：spy 但保留真实实现（验证它被 onRetry 用解析出的幽灵 tag + 'detour' 调用）。
  const pruneSpy = jest.spyOn(pm, 'pruneTagsClosure');
  // idToTagMap：让 pruneTagsClosure 能把幽灵 tag 反查到 serverId（这里 GHOST→sel 即可，仅为不报错）。
  pm.currentIdToTagMap = new Map<string, string>();

  return { pm, pruneSpy };
}

// retry 的退避用真实 setTimeout（src/main/utils/retry.ts 的 sleep）。为避免实测等 2s+4s 真实退避拖慢
// 单测，全局把 setTimeout 的延迟改为「立即触发」（仅压缩等待，不改 retry 的次数/顺序语义）。
let realSetTimeout: typeof setTimeout;
beforeEach(() => {
  realSetTimeout = global.setTimeout;
  // 保留真实调度（用 0ms），只压掉退避时长——retry 的 attempt 次数/onRetry 触发不受影响。
  (global as Any).setTimeout = ((fn: (...a: any[]) => void, _ms?: number, ...args: any[]) =>
    realSetTimeout(fn, 0, ...args)) as typeof setTimeout;
});
afterEach(() => {
  global.setTimeout = realSetTimeout;
  jest.restoreAllMocks();
});

/** 捕获 start() 终态，避免 unhandled rejection。 */
async function settle<T>(
  p: Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; msg: string }> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, msg: (e as Error).message };
  }
}

/**
 * 本用例走完整的 start() → run 阶段 FATAL → retry → onRetry 修正 → 二次 start 链路，涉及真实 fs 与进程装配。
 * 本机（Linux）实测 **112 ms**，但 **Windows CI 上曾超出 jest 默认的 5000 ms 判红**（同次 macOS 与本机全绿，
 * 且那次 main 的改动完全不沾 run-phase/ProxyManager/retry —— 是 flake 不是回归）。故给足超时。
 *
 * **成因未确证，且已排除一个候选**（我没有 Windows 环境复现，如实记，不要据此推断）：
 *  · 已排除「测试把 `global.setTimeout` 全局改成立即触发 → 自我重排的定时器变热循环」这条：本机把
 *    `process.platform` 伪装成 'win32' 后，两个用例仍各只花几十毫秒，未复现变慢。
 *  · 顺带核实到一条**与平台无关的既有问题**：本文件跑完后 jest 进程不会自行退出（`timeout` 下 rc=124，
 *    需 `--forceExit`；全量跑时表现为 `A worker process has failed to exit gracefully`）。即 start() 路径
 *    留下了未清理的句柄/定时器。它不是本次超时的已证成因，但确实存在，且会拖长收尾——单独议题。
 *  · 剩余候选：Windows runner 的冷文件系统 + AV 扫描把 fs 密集路径拖慢一两个数量级。
 *
 * 要给出确证结论需在真 Windows 上跑本文件并计时，尚未做。
 */
describe('A7 run-phase 备用腿：retry 的 shouldRetry / onRetry 对 dependency[X] not found 的处理', () => {
  it('dependency-not-found → onRetry 解析幽灵 tag + pruneTagsClosure(detour) 修正；refFixAttempted 单次闸只修一次、第二次不再重试', async () => {
    const { pm, pruneSpy } = makePm();
    const config = makeConfig();

    // startSingBoxProcess 恒抛带幽灵 tag 的 run 阶段 FATAL：
    // 首次 attempt(0) 失败 → shouldRetry(refFixAttempted=false) 返 true → onRetry(修正、置闸) → 退避 →
    // attempt(1) 仍失败 → shouldRetry(refFixAttempted=true) 返 false → 抛出（不再重试）。
    let attempts = 0;
    const startProc = jest.spyOn(pm, 'startSingBoxProcess').mockImplementation(async () => {
      attempts++;
      throw new Error('FATAL[2026] start service: dependency[ghost-tag] not found for outbound[0]');
    });

    // 闸初值应为 false（startInternal 入口会重置）。推进 retry 的退避计时器（2s, 指数退避），跑完全部 attempt + onRetry。
    const res = await settle(pm.start(config, { interactive: true }));

    // —— 断言 ——
    // 最终失败冒泡（refFixAttempted 闸住后第二次 dependency 错误 → shouldRetry 返 false → 抛）。
    expect(res.ok).toBe(false);
    expect((res as Any).msg).toMatch(/dependency\[ghost-tag\] not found/);

    // 只重试一次：startSingBoxProcess 被调 2 次（初次 + 1 次重试），不是 maxRetries=2 的全部 3 次。
    expect(startProc).toHaveBeenCalledTimes(2);

    // onRetry 单次闸：pruneTagsClosure 只被调用一次（refFixAttempted 第二次为 true，shouldRetry 提前返 false）。
    expect(pruneSpy).toHaveBeenCalledTimes(1);
    // onRetry 用正则解析出的幽灵 tag 调用 pruneTagsClosure(cfg, config, Set{'ghost-tag'}, 'detour')。
    const [, passedConfig, seedTags, origin] = pruneSpy.mock.calls[0];
    expect(origin).toBe('detour');
    expect(seedTags).toBeInstanceOf(Set);
    expect((seedTags as Set<string>).has('ghost-tag')).toBe(true);
    expect(passedConfig).toBe(config);

    // refFixAttempted 闸最终为 true（已用过一次修正腿）。
    expect(pm.refFixAttempted).toBe(true);
  }, 30_000);

  it('非 dependency 类的 run 错误：不走 ref-fix 腿（pruneTagsClosure 不因 ref-fix 被调），按通用 retry 规则处理', async () => {
    const { pm, pruneSpy } = makePm();
    const config = makeConfig();
    // 通用临时性错误（非 dependency-not-found、非 nonRetryable）：shouldRetry 走默认 true 分支，
    // onRetry 的 depMatch 不命中 → 不调 pruneTagsClosure；重试到 maxRetries(2) 用尽后冒泡。
    const startProc = jest.spyOn(pm, 'startSingBoxProcess').mockImplementation(async () => {
      throw new Error('some transient start failure');
    });
    const res = await settle(pm.start(config, { interactive: true }));

    expect(res.ok).toBe(false);
    expect((res as Any).msg).toMatch(/some transient start failure/);
    // 初次 + maxRetries(2) = 3 次尝试。
    expect(startProc).toHaveBeenCalledTimes(3);
    // ref-fix 腿未触发。
    expect(pruneSpy).not.toHaveBeenCalled();
    expect(pm.refFixAttempted).toBe(false);
  });
});
