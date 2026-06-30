/**
 * 自定义协议（custom raw-JSON，如 snell）兼容性 probe 单测。
 * 本项目铁律：runtime 语义（内核兼容性）code review 判不准，须以「mock 内核 check 行为 + 断言 FlowZ 包裹/判定」验证。
 *
 * 验证「内核即权威」不变量：ProxyManager.probeOutbound 把用户 JSON 包成最小 config 跑 sing-box check，
 * verdict 完全由内核 check 结果决定。covers：
 *  - snell 在官方内核 → check 报 `unknown outbound type: snell` → probe fail（不支持需第三方内核）。
 *  - 同一份 snell 在第三方内核（mock check 通过）→ probe ok（证 verdict 只跟内核走，与 FlowZ 无关）。
 *  - 第三方内核字段校验委托：字段非法（缺 psk 等）→ 内核 fail → probe 透传该错。
 *  - outbound vs endpoint 两种最小 config 包裹形态正确（probe tag 注入 / direct 兜底 / route.final）。
 *  - failOpen（核缺失/超时）→ indeterminate（中性「无法判定」，非红色「不支持」）。
 *  - 非法入参（非对象 / 无 string type）→ 直接 fail，不触发 check。
 *
 * snell schema 取自第三方 fork nekolsd/sing-box 官方文档（version 为 int 非 string，必填 psk）。
 */

import * as os from 'os';
import * as fsSync from 'fs';
import * as path from 'path';

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-probe-test-'));
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

// 仅 mock execFile（runSingBoxCheck 经 promisify(execFile) 调用）；其余保留真实实现
// （ProxyManager 导入链里 SystemProxyManager 顶层 promisify(exec) 等需要真函数）。
const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: (...args: any[]) => mockExecFile(...args),
}));

import { ProxyManager } from '../ProxyManager';

/** execFile(file, args, opts?, cb)：opts 可省略 → cb 顶到第 3 参。 */
function cbOf(args: any[]): (err: any, stdout?: string, stderr?: string) => void {
  return typeof args[2] === 'function' ? args[2] : args[3];
}
/** 从 execFile 参数取 `check -c <path>` 的配置路径并解析其内容（断言包裹形态用）。 */
function readProbeConfig(args: any[]): any {
  const argv = args[1] as string[];
  const ci = argv.indexOf('-c');
  const p = ci >= 0 ? argv[ci + 1] : argv[argv.length - 1];
  return JSON.parse(fsSync.readFileSync(p, 'utf-8'));
}

function freshPm(): any {
  // 假 singboxPath：statSync 抛 → binId='na'；getCoreVersion 真 exec 失败 → 回落 bundledCoreVersion。互不影响 probe 判定。
  const pm: any = new ProxyManager(
    undefined,
    undefined,
    path.join(TMP, 'cfg.json'),
    '/fake/sing-box'
  );
  pm.logToManager = () => {};
  return pm;
}

const SNELL = {
  type: 'snell',
  server: '1.2.3.4',
  server_port: 8388,
  psk: 'my-pre-shared-key',
  version: 4,
};

beforeEach(() => mockExecFile.mockReset());

describe('probeOutbound — 内核即权威 verdict', () => {
  it('官方内核拒 snell（unknown outbound type）→ probe fail，透传内核错', async () => {
    const pm = freshPm();
    let seenCfg: any = null;
    mockExecFile.mockImplementationOnce((...args: any[]) => {
      seenCfg = readProbeConfig(args);
      const err: any = new Error('check failed');
      err.code = 1;
      err.stderr =
        'FATAL[0000] decode config at x.json: outbounds[0]: unknown outbound type: snell';
      cbOf(args)(err);
    });
    const r = await pm.probeOutbound(SNELL, false);
    expect(r.ok).toBe(false);
    expect(r.indeterminate).toBeFalsy();
    expect(r.error).toMatch(/unknown outbound type: snell/);
    // 包裹形态：outbound 路径 → outbounds:[{...snell, tag:'probe'}, {direct}], route.final='direct'
    expect(seenCfg.outbounds[0].type).toBe('snell');
    expect(seenCfg.outbounds[0].tag).toBe('probe');
    expect(seenCfg.outbounds.some((o: any) => o.type === 'direct')).toBe(true);
    expect(seenCfg.route.final).toBe('direct');
  });

  it('第三方内核支持 snell（check 通过）→ probe ok（同一份 JSON，verdict 只跟内核）', async () => {
    const pm = freshPm();
    mockExecFile.mockImplementationOnce((...args: any[]) => cbOf(args)(null, '', ''));
    const r = await pm.probeOutbound(SNELL, false);
    expect(r.ok).toBe(true);
  });

  it('第三方内核字段校验委托：缺 psk → 内核 fail → probe 透传 `psk is required`', async () => {
    const pm = freshPm();
    const badSnell = { type: 'snell', server: '1.2.3.4', server_port: 8388, version: 4 }; // 无 psk
    mockExecFile.mockImplementationOnce((...args: any[]) => {
      const err: any = new Error('check failed');
      err.code = 1;
      err.stderr = 'FATAL[0000] initialize outbound[0]: snell: psk is required';
      cbOf(args)(err);
    });
    const r = await pm.probeOutbound(badSnell, false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/psk is required/);
  });

  it('isEndpoint=true → 最小 config 走 endpoints[] 包裹', async () => {
    const pm = freshPm();
    let seenCfg: any = null;
    mockExecFile.mockImplementationOnce((...args: any[]) => {
      seenCfg = readProbeConfig(args);
      cbOf(args)(null, '', '');
    });
    const epLike = { type: 'some-endpoint', server: '1.2.3.4' };
    const r = await pm.probeOutbound(epLike, true);
    expect(r.ok).toBe(true);
    expect(Array.isArray(seenCfg.endpoints)).toBe(true);
    expect(seenCfg.endpoints[0].type).toBe('some-endpoint');
    expect(seenCfg.endpoints[0].tag).toBe('probe');
    // endpoint 路径 outbounds 仅兜底 direct（无 probe 节点混入 outbounds）
    expect(seenCfg.outbounds.every((o: any) => o.type === 'direct')).toBe(true);
  });

  it('failOpen（核缺失/超时）→ indeterminate（中性无法判定，非红色不支持）', async () => {
    const pm = freshPm();
    mockExecFile.mockImplementationOnce((...args: any[]) => {
      const err: any = new Error('spawn ENOENT');
      err.code = 'ENOENT';
      cbOf(args)(err);
    });
    const r = await pm.probeOutbound(SNELL, false);
    expect(r.ok).toBe(false);
    expect(r.indeterminate).toBe(true);
  });

  it('非法入参（无 string type）→ 直接 fail，不触发 check', async () => {
    const pm = freshPm();
    const r = await pm.probeOutbound({ server: '1.2.3.4' }, false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/type/);
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe('probeCache LRU 上限（性能 review M1）', () => {
  it('超 MAX_PROBE_CACHE 上限驱逐最旧（真实 probeOutbound 驱动，约束实现驱逐逻辑）', async () => {
    const pm = freshPm();
    const MAX = (ProxyManager as any).MAX_PROBE_CACHE as number;
    expect(MAX).toBeGreaterThan(0);

    // 真实 probeOutbound 驱动（不同 server_port → 不同 sha1 key），不复制实现驱逐逻辑——
    // 若实现驱逐改成"删最新/漏 while/边界 off-by-one"，本测试会红（R2 review L1：原隔离测试零约束）。
    // mock execFile 同步回调，单次 probe <1ms，MAX+20 次（2068）远不至超时。
    mockExecFile.mockImplementation((...args: any[]) => cbOf(args)(null, '', ''));
    const total = MAX + 20;
    for (let i = 1; i <= total; i++) {
      await pm.probeOutbound({ ...SNELL, server_port: 10000 + i }, false);
    }
    // probeCache.size 不超上限（实现的 while 驱逐生效）
    expect(pm.probeCache.size).toBe(MAX);
    // 最近 probe 的（port 10000+total）应在缓存
    expect(await pm.probeOutbound({ ...SNELL, server_port: 10000 + total }, false)).toMatchObject({
      ok: true,
    });
    // 超时根治（CI flaky）：MAX≈2048 → MAX+20 次真实 probe，每次含 sha1 + tmp config 写。本机 ~2-3s，但 CI
    // 慢文件 IO（windows/macos runner）实测可达 ~30s，撞原 30000ms 硬超时 → jest 中断该用例 → 已在飞的 probe
    // promise 泄漏，回调时污染下一用例「命中缓存」的 mockExecFile 计数（Received 2）→ 连锁 2 fail + worker 不优雅退出。
    // 给 ~3x 余量使该用例在慢 CI 也必跑完（无中断、无 in-flight 泄漏），根除该 flaky。
  }, 90000);

  it('probeOutbound 实际命中缓存（不重复 spawn check）', async () => {
    mockExecFile.mockReset(); // 隔离前一个 case 的 mock 状态
    mockExecFile.mockImplementation((...args: any[]) => cbOf(args)(null, '', ''));
    const pm = freshPm();
    // 首次 probe：触发 check
    await pm.probeOutbound(SNELL, false);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    // 再次 probe 同一 outbound：应命中缓存，不再 check
    mockExecFile.mockClear();
    const r = await pm.probeOutbound(SNELL, false);
    expect(r.ok).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
