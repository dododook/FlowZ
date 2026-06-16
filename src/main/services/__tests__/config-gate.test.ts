/**
 * 启动前配置校验 gate（坏节点不拖垮 sing-box 整体启动）单测。
 * 本项目铁律：runtime 语义改动 code review 判不准，须以生成物 + 纯函数 + mock check 行为断言验证。
 *
 * 覆盖（对应 docs/design/config-validation-startup-gate.md 测试计划）：
 *  - parseCheckOutboundIndex：两种 stderr 格式（复数 outbounds[i] / 单数 outbound[i]）/ 不命中 / 越界宽容。
 *  - checkAndPruneConfig 剔除算法：坏节点 + detour 引用方 + 好节点 → 断言 outbounds/selector/default/route/
 *    idToTagMap/gateInvalidNodes/事件。
 *  - shadow-tls 同剔（节点 ↔ stls-out- 外层配对）。
 *  - 选中节点被 check 标中 → throw（决策①，不自动回退）。
 *  - 全部剔光 → throw「没有可用的代理节点」。
 *  - detour 预校验（generateOutbounds 尾）：死引用剔除 + 选中节点 throw。
 *  - 迭代收敛（execFile 多轮 mockImplementationOnce）。
 *  - 降级：无下标 throw / ENOENT fail-open / 超时 fail-open / 命中非节点出站 throw / 上限 throw。
 */

// ── mock 必须在 import 之前 ──────────────────────────────────────────
import * as os from 'os';
import * as fsSync from 'fs';
import * as path from 'path';

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-gate-test-'));
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

// mock child_process.execFile：runSingBoxCheck 经 promisify(require('child_process').execFile) 调用。
// execFile(file, args, opts, cb) —— 失败 cb(err)（err.code=1 + err.stderr=FIXTURE），成功 cb(null,'','')，
// ENOENT cb(err{code:'ENOENT'})，超时 cb(err{killed:true})。多轮用 mockImplementationOnce 串联。
// 仅覆盖 execFile，其余（exec/execSync/spawn）保留真实实现——ProxyManager 导入链里 SystemProxyManager
// 顶层 `promisify(exec)` 等需要真实函数，否则模块加载即报错。
const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: (...args: any[]) => mockExecFile(...args),
}));

import { ProxyManager, parseCheckOutboundIndex, parseCheckEndpointIndex } from '../ProxyManager';
import { resourceManager } from '../ResourceManager';
import type { InvalidNodeInfo } from '../../../shared/types';

type AnyCfg = any;

/** execFile 回调适配：opts 可省略（cb 顶到第 3 参）。 */
function callDone(args: any[], err: any, stdout = '', stderr = '') {
  const cb = typeof args[2] === 'function' ? args[2] : args[3];
  if (err) cb(err);
  else cb(null, stdout, stderr);
}
function checkFailOnce(stderr: string) {
  mockExecFile.mockImplementationOnce((...args: any[]) => {
    const err: any = new Error('check failed');
    err.code = 1;
    err.stderr = stderr;
    callDone(args, err);
  });
}
function checkOkOnce() {
  mockExecFile.mockImplementationOnce((...args: any[]) => callDone(args, null, '', ''));
}

/** 构造一个最小可剔除的 singboxConfig：节点 outbounds + proxy-selector + direct/block + 可选 route 规则。 */
function makeSbConfig(opts: {
  nodes: { tag: string; detour?: string; type?: string }[];
  selectorMembers: string[];
  selectorDefault: string;
  routeRules?: { action?: string; outbound?: string }[];
}): AnyCfg {
  const outbounds: AnyCfg[] = opts.nodes.map((n) => ({
    type: n.type || 'shadowsocks',
    tag: n.tag,
    ...(n.detour ? { detour: n.detour } : {}),
  }));
  outbounds.push({
    type: 'selector',
    tag: 'proxy-selector',
    outbounds: [...opts.selectorMembers],
    default: opts.selectorDefault,
  });
  outbounds.push({ type: 'direct', tag: 'direct' });
  outbounds.push({ type: 'block', tag: 'block' });
  return {
    log: { level: 'info' },
    inbounds: [],
    outbounds,
    route: { rules: opts.routeRules || [] },
  };
}

/** 在临时目录建一份独立 ProxyManager（注入 configPath + 假 singboxPath），并预设 idToTagMap / gateInvalidNodes。 */
function makePm(idToTag: Record<string, string>) {
  const configPath = path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`);
  const pm: any = new ProxyManager(undefined, undefined, configPath, '/fake/sing-box');
  pm.currentIdToTagMap = new Map(Object.entries(idToTag));
  pm.gateInvalidNodes = new Map<string, InvalidNodeInfo>();
  // sendEventToRenderer 无 mainWindow → no-op，捕获最后一次推送的事件 payload 供断言。
  pm._sentInvalidNodes = undefined;
  pm.sendEventToRenderer = (_ch: string, data: any) => {
    pm._sentInvalidNodes = data;
  };
  pm.logToManager = () => {};
  return { pm, configPath };
}

beforeEach(() => {
  mockExecFile.mockReset();
});

describe('parseCheckOutboundIndex', () => {
  it('decode 复数格式 outbounds[2].method', () => {
    expect(parseCheckOutboundIndex('FATAL outbounds[2].method: unknown method')).toBe(2);
  });
  it('initialize 单数格式 outbound[5]', () => {
    expect(parseCheckOutboundIndex('initialize outbound[5]: bad')).toBe(5);
  });
  it('dependency not found 单数 outbound', () => {
    expect(parseCheckOutboundIndex('dependency[ghost] not found for outbound[3]')).toBe(3);
  });
  it('不命中 → null', () => {
    expect(parseCheckOutboundIndex('some unrelated error')).toBeNull();
  });
  it('下标 0', () => {
    expect(parseCheckOutboundIndex('outbounds[0].password missing')).toBe(0);
  });
  it('endpoints[N] 不被 outbound 解析器误命中', () => {
    expect(parseCheckOutboundIndex('endpoints[1]: unknown endpoint type: snell')).toBeNull();
  });
});

describe('parseCheckEndpointIndex', () => {
  it('命中 endpoints[N]（自定义 endpoint 不兼容 type）', () => {
    expect(parseCheckEndpointIndex('endpoints[0]: unknown endpoint type: foo')).toBe(0);
    expect(parseCheckEndpointIndex('endpoint[2]: bad')).toBe(2);
  });
  it('outbounds[N] 不被 endpoint 解析器误命中 / 无关错误 → null', () => {
    expect(parseCheckEndpointIndex('outbounds[2].method: unknown')).toBeNull();
    expect(parseCheckEndpointIndex('some unrelated error')).toBeNull();
  });
});

describe('checkAndPruneConfig 剔除算法', () => {
  it('坏节点（非选中）被 check 标中 → 剔出 outbounds/selector，route 死引用修正，记 gateInvalidNodes + 发事件', async () => {
    const { pm } = makePm({ a: 'A', b: 'B', c: 'C' });
    const sb = makeSbConfig({
      nodes: [{ tag: 'A' }, { tag: 'B' }, { tag: 'C' }],
      selectorMembers: ['A', 'B', 'C'],
      selectorDefault: 'A',
      routeRules: [{ action: 'route', outbound: 'B' }],
    });
    // 第一轮 check 标 B（outbounds[1]），第二轮通过。
    checkFailOnce('FATAL outbounds[1].method: unknown method');
    checkOkOnce();
    await pm.checkAndPruneConfig(sb, {
      servers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      selectedServerId: 'a',
    });
    const tags = sb.outbounds.map((o: AnyCfg) => o.tag);
    expect(tags).not.toContain('B');
    expect(tags).toContain('A');
    expect(tags).toContain('C');
    const sel = sb.outbounds.find((o: AnyCfg) => o.tag === 'proxy-selector');
    expect(sel.outbounds).toEqual(['A', 'C']);
    // route 规则原指向 B（死引用）→ 修正回 proxy-selector
    expect(sb.route.rules[0].outbound).toBe('proxy-selector');
    expect(pm.currentIdToTagMap.has('b')).toBe(false);
    expect(pm.gateInvalidNodes.has('b')).toBe(true);
    expect(pm._sentInvalidNodes).toHaveLength(1);
    expect(pm._sentInvalidNodes[0].id).toBe('b');
  });

  it('detour 引用方级联：剔除被引用节点同时剔除引用方', async () => {
    const { pm } = makePm({ a: 'A', b: 'B', c: 'C' });
    // C detour 指向 B；标中 B → B 与 C 一并剔。
    const sb = makeSbConfig({
      nodes: [{ tag: 'A' }, { tag: 'B' }, { tag: 'C', detour: 'B' }],
      selectorMembers: ['A', 'B', 'C'],
      selectorDefault: 'A',
    });
    checkFailOnce('outbounds[1].password: invalid');
    checkOkOnce();
    await pm.checkAndPruneConfig(sb, {
      servers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      selectedServerId: 'a',
    });
    const tags = sb.outbounds.map((o: AnyCfg) => o.tag);
    expect(tags).not.toContain('B');
    expect(tags).not.toContain('C');
    const sel = sb.outbounds.find((o: AnyCfg) => o.tag === 'proxy-selector');
    expect(sel.outbounds).toEqual(['A']);
    expect(pm.gateInvalidNodes.has('b')).toBe(true);
    expect(pm.gateInvalidNodes.has('c')).toBe(true);
  });

  it('shadow-tls 同剔：剔 stls-out- 外层 → 内层主节点一并剔', async () => {
    const { pm } = makePm({ a: 'A', b: 'B' });
    // B 主节点 detour 指向 stls-out-b 外层；标中外层（outbounds[2]）→ 外层 + B 一并剔。
    const sb = makeSbConfig({
      nodes: [{ tag: 'A' }, { tag: 'B', detour: 'stls-out-b' }],
      selectorMembers: ['A', 'B'],
      selectorDefault: 'A',
    });
    sb.outbounds.push({ type: 'shadowtls', tag: 'stls-out-b' });
    // outbounds: [A(0), B(1), proxy-selector(2), direct(3), block(4), stls-out-b(5)]
    checkFailOnce('outbounds[5].password: invalid');
    checkOkOnce();
    await pm.checkAndPruneConfig(sb, {
      servers: [{ id: 'a' }, { id: 'b' }],
      selectedServerId: 'a',
    });
    const tags = sb.outbounds.map((o: AnyCfg) => o.tag);
    expect(tags).not.toContain('stls-out-b');
    expect(tags).not.toContain('B');
    expect(tags).toContain('A');
    expect(pm.gateInvalidNodes.has('b')).toBe(true);
  });

  it('选中节点被 check 标中 → throw 请更换节点（不自动回退）', async () => {
    const { pm } = makePm({ a: 'A', b: 'B' });
    const sb = makeSbConfig({
      nodes: [{ tag: 'A' }, { tag: 'B' }],
      selectorMembers: ['A', 'B'],
      selectorDefault: 'A',
    });
    checkFailOnce('outbounds[0].method: unknown method'); // A = 选中
    await expect(
      pm.checkAndPruneConfig(sb, {
        servers: [{ id: 'a' }, { id: 'b' }],
        selectedServerId: 'a',
      })
    ).rejects.toThrow(/更换节点/);
  });

  it('全部节点剔光 → throw 没有可用的代理节点', async () => {
    const { pm } = makePm({ a: 'A', b: 'B' });
    const sb = makeSbConfig({
      nodes: [{ tag: 'A' }, { tag: 'B' }],
      selectorMembers: ['A', 'B'],
      selectorDefault: 'B',
    });
    // 选中 b（tag B）；先标 A（outbounds[0]）剔掉，再标 B → B 是选中 → 应在级联前命中选中 throw。
    // 为测「剔空」语义，改选中为不存在 id，让两节点都可剔：
    pm.gateInvalidNodes = new Map();
    const cfg = { servers: [{ id: 'a' }, { id: 'b' }], selectedServerId: 'zzz' };
    checkFailOnce('outbounds[0].method: bad'); // 剔 A
    checkFailOnce('outbounds[0].method: bad'); // 剩 [B,selector,...]，B 在下标0 → 剔 B → selector 空
    await expect(pm.checkAndPruneConfig(sb, cfg)).rejects.toThrow(/没有可用的代理节点/);
  });

  it('降级：stderr 无下标 → throw 配置校验失败（不误剔）', async () => {
    const { pm } = makePm({ a: 'A' });
    const sb = makeSbConfig({
      nodes: [{ tag: 'A' }],
      selectorMembers: ['A'],
      selectorDefault: 'A',
    });
    checkFailOnce('some opaque parse error without index');
    await expect(
      pm.checkAndPruneConfig(sb, { servers: [{ id: 'a' }], selectedServerId: 'a' })
    ).rejects.toThrow(/配置校验失败/);
  });

  it('降级：命中非节点出站（proxy-selector）→ throw 配置校验失败', async () => {
    const { pm } = makePm({ a: 'A' });
    const sb = makeSbConfig({
      nodes: [{ tag: 'A' }],
      selectorMembers: ['A'],
      selectorDefault: 'A',
    });
    // proxy-selector 在 outbounds[1]
    checkFailOnce('outbounds[1].outbounds: bad');
    await expect(
      pm.checkAndPruneConfig(sb, { servers: [{ id: 'a' }], selectedServerId: 'a' })
    ).rejects.toThrow(/配置校验失败/);
  });

  it('fail-open：ENOENT（核心不可执行）→ 跳过 gate 不抛，按现状启动', async () => {
    const { pm } = makePm({ a: 'A' });
    const sb = makeSbConfig({
      nodes: [{ tag: 'A' }],
      selectorMembers: ['A'],
      selectorDefault: 'A',
    });
    mockExecFile.mockImplementationOnce((...args: any[]) => {
      const err: any = new Error('spawn ENOENT');
      err.code = 'ENOENT';
      callDone(args, err);
    });
    await expect(
      pm.checkAndPruneConfig(sb, { servers: [{ id: 'a' }], selectedServerId: 'a' })
    ).resolves.toBeUndefined();
    // 未剔任何节点
    expect(sb.outbounds.some((o: AnyCfg) => o.tag === 'A')).toBe(true);
  });

  it('fail-open：超时（killed）→ 跳过 gate 不抛', async () => {
    const { pm } = makePm({ a: 'A' });
    const sb = makeSbConfig({
      nodes: [{ tag: 'A' }],
      selectorMembers: ['A'],
      selectorDefault: 'A',
    });
    mockExecFile.mockImplementationOnce((...args: any[]) => {
      const err: any = new Error('timeout');
      err.killed = true;
      callDone(args, err);
    });
    await expect(
      pm.checkAndPruneConfig(sb, { servers: [{ id: 'a' }], selectedServerId: 'a' })
    ).resolves.toBeUndefined();
  });

  it('上限：超过 min(50,N) 仍失败 → throw 含已剔数', async () => {
    const { pm } = makePm({ a: 'A', b: 'B' });
    const sb = makeSbConfig({
      nodes: [{ tag: 'A' }, { tag: 'B' }],
      selectorMembers: ['A', 'B'],
      selectorDefault: 'A',
    });
    // N=2 → 上限 2。前两轮各剔一个（A 然后 B），第三轮仍失败但 selector 已空会先 throw 没有可用节点。
    // 为单测上限语义，构造一个永远命中下标 0 但节点充足（N 大）的场景较繁；这里验证「剔到空」优先 throw。
    checkFailOnce('outbounds[0].x: bad');
    checkFailOnce('outbounds[0].x: bad');
    await expect(
      pm.checkAndPruneConfig(sb, {
        servers: [{ id: 'a' }, { id: 'b' }],
        selectedServerId: 'zzz',
      })
    ).rejects.toThrow();
  });

  it('上限命中 throw：每轮标一个新的非选中节点、selector 不剔空、选中永不被标 → 剔到 prunes>=min(50,N) 仍 fail → throw 含已剔数', async () => {
    // 设计：maxPrunes = min(50, config.servers.length)。让 config.servers 取 3 → maxPrunes=3；
    // singbox selector 给 5 个成员（选中 SEL + 4 个可剔 N1..N4），保证剔 3 个后 selector 仍非空，
    // 不会先命中 pruneTagsClosure 的「没有可用的代理节点」throw。
    // 选中节点（SEL）永不被标 → 不命中「请更换节点」throw。
    // 每轮 check 标一个新的非选中节点（按剔除后下标重算）→ 迭代剔到 prunes=3=maxPrunes，
    // 第 4 轮 check 仍 fail 且 prunes>=maxPrunes → 命中 ProxyManager.ts:3963 的上限 throw。
    const { pm } = makePm({ sel: 'SEL', n1: 'N1', n2: 'N2', n3: 'N3', n4: 'N4' });
    const sb = makeSbConfig({
      nodes: [{ tag: 'SEL' }, { tag: 'N1' }, { tag: 'N2' }, { tag: 'N3' }, { tag: 'N4' }],
      selectorMembers: ['SEL', 'N1', 'N2', 'N3', 'N4'],
      selectorDefault: 'SEL',
    });
    // outbounds 初始: [SEL(0), N1(1), N2(2), N3(3), N4(4), proxy-selector(5), direct, block]
    // 轮1 标 N1(idx1) → 剔后 [SEL,N2,N3,N4,...]，prunes=1
    // 轮2 标 N2(idx1) → 剔后 [SEL,N3,N4,...]，prunes=2
    // 轮3 标 N3(idx1) → 剔后 [SEL,N4,...]，prunes=3
    // 轮4 标 N4(idx1)（仍 fail）→ 进入循环顶先判 prunes(3)>=maxPrunes(3) → throw（N4 不会被剔，selector 仍含 SEL,N4）
    checkFailOnce('outbounds[1].method: bad'); // 轮1 N1
    checkFailOnce('outbounds[1].method: bad'); // 轮2 N2
    checkFailOnce('outbounds[1].method: bad'); // 轮3 N3
    checkFailOnce('outbounds[1].method: bad'); // 轮4 仍 fail → 上限 throw（不再剔）
    const p = pm.checkAndPruneConfig(sb, {
      // 3 个 server → maxPrunes = min(50,3) = 3
      servers: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }],
      selectedServerId: 'sel',
    });
    // 文案含「已剔除 3」+「无法通过校验」；命中的是上限分支而非「没有可用的代理节点」/「更换节点」。
    await expect(p).rejects.toThrow(/已剔除 3 个非法节点仍无法通过校验/);
    // 旁证：确实剔了 3 个（N1/N2/N3），且选中 SEL 与 N4 仍在 → selector 未剔空、选中未被标。
    expect(pm.gateInvalidNodes.size).toBe(3);
    const tags = sb.outbounds.map((o: AnyCfg) => o.tag);
    expect(tags).toContain('SEL');
    expect(tags).toContain('N4');
    const sel = sb.outbounds.find((o: AnyCfg) => o.tag === 'proxy-selector');
    expect(sel.outbounds).toEqual(['SEL', 'N4']);
  });

  it('迭代收敛：连续两个坏节点（多轮 mockOnce）剔除后通过', async () => {
    const { pm } = makePm({ a: 'A', b: 'B', c: 'C', d: 'D' });
    const sb = makeSbConfig({
      nodes: [{ tag: 'A' }, { tag: 'B' }, { tag: 'C' }, { tag: 'D' }],
      selectorMembers: ['A', 'B', 'C', 'D'],
      selectorDefault: 'A',
    });
    // 轮1标 B(idx1)；剔 B 后 outbounds=[A,C,D,selector,...]，轮2标 D(idx2)；剔 D 后通过。
    checkFailOnce('outbounds[1].x: bad');
    checkFailOnce('outbounds[2].x: bad');
    checkOkOnce();
    await pm.checkAndPruneConfig(sb, {
      servers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      selectedServerId: 'a',
    });
    const tags = sb.outbounds.map((o: AnyCfg) => o.tag);
    expect(tags).toEqual(expect.arrayContaining(['A', 'C']));
    expect(tags).not.toContain('B');
    expect(tags).not.toContain('D');
    expect(pm.gateInvalidNodes.size).toBe(2);
  });
});

describe('detour 引用预校验（generateOutbounds 尾，补 check 盲区）', () => {
  const NODE = (over: AnyCfg) => ({
    name: over.name,
    id: over.id,
    protocol: 'vless',
    address: 'a.example.com',
    port: 443,
    uuid: '00000000-0000-0000-0000-00000000000a',
    tlsSettings: { serverName: 'a.example.com' },
    ...over,
  });

  it('detour 指向不存在的节点 id → 引用方被剔（非选中），selector 不含它', () => {
    // 为触发预校验死引用，detour 须指向「存在于 servers 但 generate 出来 tag 不在集合」的情况——
    // 用 naive 缺库节点被跳过来制造：n3 是 naive，n2.detour 指向 n3。强制 hasCronetLib=false 以保证
    // n3 被跳过（CI 环境 getCronetLibStatus 可能乐观返回 available，否则测试随环境抖动）。
    const cronetSpy = jest.spyOn(resourceManager, 'hasCronetLib').mockReturnValue(false);
    try {
      const pm: any = new ProxyManager(undefined, undefined, path.join(TMP, 'g1.json'), '/fake/sb');
      pm.logToManager = () => {};
      const servers = [
        NODE({ id: 'n1', name: 'N1' }),
        NODE({ id: 'n2', name: 'N2', detour: 'n3' }),
        NODE({
          id: 'n3',
          name: 'N3',
          protocol: 'naive',
          naiveSettings: { username: 'u', password: 'p' },
        }),
      ];
      const cfg: AnyCfg = {
        servers,
        selectedServerId: 'n1',
        proxyMode: 'smart',
        proxyModeType: 'tun',
        appRules: [],
        appRoutingEnabled: true,
        dnsConfig: { domesticDns: 'x', foreignDns: 'y', enableFakeIp: true },
      };
      const sb = pm.generateSingBoxConfig(cfg) as AnyCfg;
      const tags = sb.outbounds.map((o: AnyCfg) => o.tag);
      // n3 naive 缺库被跳过；n2 detour 指向 n3 的 tag（死引用）→ n2 被预校验剔除。
      expect(tags).not.toContain('N3');
      expect(pm.gateInvalidNodes.has('n2')).toBe(true);
      const sel = sb.outbounds.find((o: AnyCfg) => o.tag === 'proxy-selector');
      expect(sel.outbounds).not.toContain('N2');
      expect(tags).toContain('N1');
    } finally {
      cronetSpy.mockRestore();
    }
  });
});
