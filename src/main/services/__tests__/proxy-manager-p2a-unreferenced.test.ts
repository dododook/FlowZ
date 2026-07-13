/**
 * ProxyManager P2-A：订阅刷新只增删/改「未被引用节点」时免整核重启（issue #176）。
 *
 * 安全核心 = referencedServerIds（被引用集）必须涵盖一切会影响运行核实际行为的节点：选中节点 + 其 detour 前置链
 * 传递闭包 + 所有启用规则目标（+ 各自 detour 链）+ 保守纳入全部 endpoint（WG/Tailscale 可能 force-route 子网）。
 * 只有「纯代理、非选中、非规则目标、不在 detour 链」的惰性 selector 成员节点变化才免重启。
 * 漏纳入 = 错误免重启致运行核用旧前置参数（流量错误/泄漏）→ 这里重点测「该重启的仍重启」。
 *
 * 私有方法/字段经 `(svc as any)` 直调。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-p2a-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));

import { ProxyManager } from '../ProxyManager';
import { DIRECT_SERVER_ID } from '../../../shared/direct-selection';
import { referencedServerIds } from '../../../shared/endpoint-routes';
import type { UserConfig, ServerConfig, Rule } from '../../../shared/types';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeSvc() {
  const configPath = path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`);
  return new ProxyManager(undefined, undefined, configPath, '/fake/sing-box') as any;
}

const ss = (id: string, addr = '1.1.1.1', extra: Partial<ServerConfig> = {}): ServerConfig =>
  ({ id, name: id, protocol: 'shadowsocks', address: addr, port: 8388, ...extra }) as any;
const wg = (id: string): ServerConfig =>
  ({
    id,
    name: id,
    protocol: 'wireguard',
    wireguardSettings: { allowedIPs: ['10.0.0.0/24'] },
  }) as any;

function cfg(servers: ServerConfig[], over: Partial<UserConfig> = {}): UserConfig {
  return {
    servers,
    selectedServerId: servers[0]?.id ?? null,
    proxyMode: 'smart',
    proxyModeType: 'tun',
    tunConfig: { enable: true } as any,
    customRules: [],
    appRules: [],
    socksPort: 1080,
    httpPort: 1081,
    logLevel: 'info',
    ...over,
  } as UserConfig;
}

describe('issue #176 P2-A — referencedServerIds 被引用集（含 detour 闭包 + endpoint）', () => {
  it('选中节点 + 其 detour 前置链传递闭包（A→B→C 全纳入）', () => {
    const c = cfg(
      [ss('A', '1.1.1.1', { detour: 'B' }), ss('B', '2.2.2.2', { detour: 'C' }), ss('C'), ss('D')],
      {
        selectedServerId: 'A',
      }
    );
    const R = referencedServerIds(c);
    expect([...R].sort()).toEqual(['A', 'B', 'C']); // D 是无关纯代理，不纳入
  });

  it('规则目标（custom + app）及其 detour 链纳入', () => {
    const rule: Rule = {
      id: 'r1',
      type: 'domainSuffix',
      values: ['x.com'],
      action: 'proxy',
      enabled: true,
      targetServerId: 'C',
    };
    const c = cfg([ss('A'), ss('B'), ss('C', '3.3.3.3', { detour: 'B' }), ss('D')], {
      selectedServerId: 'A',
      customRules: [rule],
      appRules: [{ appId: 'app1', action: 'proxy', enabled: true, targetServerId: 'D' } as any],
    });
    const R = referencedServerIds(c);
    // A(选中) + C(custom 目标)+B(C 的前置) + D(app 目标)
    expect([...R].sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('所有 endpoint（WG/TS）一律保守纳入（独立于选中）', () => {
    const c = cfg([ss('A'), ss('B'), wg('wg1')], { selectedServerId: 'A' });
    const R = referencedServerIds(c);
    expect(R.has('wg1')).toBe(true); // 未选中的 endpoint 也纳入
    expect(R.has('B')).toBe(false); // 未选中的纯代理不纳入
  });

  it('direct 哨兵选中 → 不 seed；禁用规则目标 / 悬空 detour / 成环均安全', () => {
    const disabled: Rule = {
      id: 'r1',
      type: 'domainSuffix',
      values: ['x'],
      action: 'proxy',
      enabled: false,
      targetServerId: 'B',
    };
    const c = cfg(
      [
        ss('A', '1.1.1.1', { detour: 'B' }),
        ss('B', '2.2.2.2', { detour: 'A' }),
        ss('ghost-src', '4.4.4.4', { detour: 'nope' }),
      ],
      {
        selectedServerId: DIRECT_SERVER_ID, // 直连哨兵：不 seed 任何节点
        customRules: [disabled], // 禁用规则不 seed
      }
    );
    const R = referencedServerIds(c);
    expect(R.size).toBe(0); // 无 endpoint、选中=direct、规则禁用 → 空集（成环/悬空 detour 不死循环不抛）
  });
});

describe('issue #176 P2-A — configGenerationNorm(serverIds) 过滤', () => {
  it('传 serverIds → servers 仅保留指定节点；空集 → 仅非节点字段', () => {
    const svc = makeSvc();
    const c = cfg([ss('A'), ss('B'), ss('C')], { selectedServerId: 'A' });
    // F3：servers 投影现为 serverFingerprint 串数组（复用节点序列化单一真值）→ 校验过滤留 A 且确是 A 的指纹
    expect(JSON.parse(svc.configGenerationNorm(c, new Set(['A']))).servers).toEqual([
      svc.serverFingerprint(ss('A')),
    ]);
    expect(JSON.parse(svc.configGenerationNorm(c, new Set())).servers).toEqual([]); // 空集=非节点字段对比
  });
});

describe('issue #176 P2-A + §2 P2-B — canSkipRestartForAddedUnreferenced 非对称安全判据', () => {
  it('纯新增未引用纯代理节点 → 可免重启', () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('B')], { selectedServerId: 'A' });
    const b = cfg([ss('A'), ss('B'), ss('Z', '9.9.9.9')], { selectedServerId: 'A' });
    expect(svc.canSkipRestartForAddedUnreferenced(a, b)).toBe(true);
  });

  // §2 P2-B：未引用节点的删/改改为 defer（与 SERVER_DELETE 不 emit 的现状一致，消除双路径不一致）；未引用节点不承载
  //   流量，删/改无活流量影响；被选中/被规则指向才连它 → 届时 planHotSwitch dirty 闸门退回重启补全。安全由 P2-B
  //   非对称模型 + dirty 闸门保证（非 P2-A 的「一律重启」）。
  it('删除未引用节点 → defer（P2-B，不承载流量；被选中/规则指向才退回重启）', () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('B'), ss('Z')], { selectedServerId: 'A' });
    const b = cfg([ss('A'), ss('B')], { selectedServerId: 'A' });
    expect(svc.canSkipRestartForAddedUnreferenced(a, b)).toBe(true);
  });

  it('改未引用节点 address → defer（P2-B；dirty 闸门防热切到旧参数）', () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('Z', '9.9.9.9')], { selectedServerId: 'A' });
    const b = cfg([ss('A'), ss('Z', '5.5.5.5')], { selectedServerId: 'A' }); // Z 地址变
    expect(svc.canSkipRestartForAddedUnreferenced(a, b)).toBe(true);
  });

  it('改未引用节点任一参数（同址）→ defer（P2-B）', () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('Z', '9.9.9.9', { port: 8388 })], { selectedServerId: 'A' });
    const b = cfg([ss('A'), ss('Z', '9.9.9.9', { port: 9999 })], { selectedServerId: 'A' }); // Z 端口变
    expect(svc.canSkipRestartForAddedUnreferenced(a, b)).toBe(true);
  });

  it('删/改**被规则指向**节点 → 仍重启（被引用，改/删影响活流量）', () => {
    const svc = makeSvc();
    const rule: Rule = {
      id: 'r1',
      type: 'domainSuffix',
      values: ['x.com'],
      action: 'proxy',
      enabled: true,
      targetServerId: 'Z',
    };
    const a = cfg([ss('A'), ss('Z', '9.9.9.9')], { selectedServerId: 'A', customRules: [rule] });
    // 改被规则指向的 Z 地址 → 被引用节点变 → 重启
    const b = cfg([ss('A'), ss('Z', '5.5.5.5')], { selectedServerId: 'A', customRules: [rule] });
    expect(svc.canSkipRestartForAddedUnreferenced(a, b)).toBe(false);
  });

  it('改选中节点参数 → 仍重启（选中∈旧节点、须不变）', () => {
    const svc = makeSvc();
    const a = cfg([ss('A', '1.1.1.1'), ss('B')], { selectedServerId: 'A' });
    const b = cfg([ss('A', '8.8.8.8'), ss('B')], { selectedServerId: 'A' });
    expect(svc.canSkipRestartForAddedUnreferenced(a, b)).toBe(false);
  });

  it('新增的是 endpoint 节点 → 仍重启（endpoint 被引用：可 force-route 子网）', () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('B')], { selectedServerId: 'A' });
    const b = cfg([ss('A'), ss('B'), wg('wg1')], { selectedServerId: 'A' }); // 新增 endpoint
    expect(svc.canSkipRestartForAddedUnreferenced(a, b)).toBe(false);
  });

  it('新增节点同时被规则指向（被引用）→ 仍重启', () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('B')], { selectedServerId: 'A' });
    const rule: Rule = {
      id: 'r1',
      type: 'domainSuffix',
      values: ['x.com'],
      action: 'proxy',
      enabled: true,
      targetServerId: 'Z',
    };
    const b = cfg([ss('A'), ss('B'), ss('Z')], { selectedServerId: 'A', customRules: [rule] });
    expect(svc.canSkipRestartForAddedUnreferenced(a, b)).toBe(false); // ②(规则变)与④(Z被引用)双重拦截
  });

  it('改 selectedServerId → 仍重启（①）', () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('B')], { selectedServerId: 'A' });
    const b = cfg([ss('A'), ss('B')], { selectedServerId: 'B' });
    expect(svc.canSkipRestartForAddedUnreferenced(a, b)).toBe(false);
  });

  it('改非节点字段（加规则）→ 仍重启（②）', () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('B')], { selectedServerId: 'A' });
    const rule: Rule = {
      id: 'r1',
      type: 'domainSuffix',
      values: ['x.com'],
      action: 'direct',
      enabled: true,
    };
    const b = cfg([ss('A'), ss('B')], { selectedServerId: 'A', customRules: [rule] });
    expect(svc.canSkipRestartForAddedUnreferenced(a, b)).toBe(false);
  });

  it('新增节点的 detour 指向某旧节点（链未触达选中）→ 仍可免重启（新节点整体未被引用）', () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('B')], { selectedServerId: 'A' });
    const b = cfg([ss('A'), ss('B'), ss('Z', '9.9.9.9', { detour: 'B' })], {
      selectedServerId: 'A',
    });
    // Z 未被选中/规则指向 → 不在引用集；Z.detour=B 不让 Z 被引用（引用是从选中/目标出发的闭包）→ 免重启
    expect(svc.canSkipRestartForAddedUnreferenced(a, b)).toBe(true);
  });
});

describe('issue #176 P2-A — switchMode 集成（运行中）', () => {
  function running(svc: any, current: UserConfig) {
    svc.singboxPid = 4321; // 视核为运行中
    svc.currentConfig = current;
    svc.currentIdToTagMap = new Map(current.servers.map((s) => [s.id, `tag-${s.id}`]));
    jest.spyOn(svc, 'syncCustomRuleFiles').mockResolvedValue(undefined);
  }

  it('订阅刷新加未引用节点 → 免重启（不 scheduleDebouncedRestart，更新 currentConfig）', async () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('B')], { selectedServerId: 'A' });
    running(svc, a);
    const sched = jest.spyOn(svc, 'scheduleDebouncedRestart').mockImplementation(() => {});
    const b = cfg([ss('A'), ss('B'), ss('Z', '9.9.9.9')], { selectedServerId: 'A' });
    await svc.switchMode(b);
    expect(sched).not.toHaveBeenCalled(); // 免重启
    expect(svc.currentConfig).toBe(b); // 更新到最新（新节点下次启动生效）
  });

  it('改选中节点参数 → 仍重启（scheduleDebouncedRestart 被调）', async () => {
    const svc = makeSvc();
    const a = cfg([ss('A', '1.1.1.1'), ss('B')], { selectedServerId: 'A' });
    running(svc, a);
    const sched = jest.spyOn(svc, 'scheduleDebouncedRestart').mockImplementation(() => {});
    const b = cfg([ss('A', '8.8.8.8'), ss('B')], { selectedServerId: 'A' });
    await svc.switchMode(b);
    expect(sched).toHaveBeenCalledTimes(1);
  });

  it('删未引用节点 → defer 不重启（§2 P2-B，与 SERVER_DELETE 不 emit 一致）', async () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('B'), ss('Z')], { selectedServerId: 'A' });
    running(svc, a);
    const sched = jest.spyOn(svc, 'scheduleDebouncedRestart').mockImplementation(() => {});
    const b = cfg([ss('A'), ss('B')], { selectedServerId: 'A' }); // 删 Z
    await svc.switchMode(b);
    expect(sched).not.toHaveBeenCalled();
  });

  it('编辑未引用节点 → defer 不重启（§2 P2-B）', async () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('Z', '9.9.9.9')], { selectedServerId: 'A' });
    running(svc, a);
    const sched = jest.spyOn(svc, 'scheduleDebouncedRestart').mockImplementation(() => {});
    const b = cfg([ss('A'), ss('Z', '5.5.5.5')], { selectedServerId: 'A' }); // 改未引用 Z 地址
    await svc.switchMode(b);
    expect(sched).not.toHaveBeenCalled();
  });

  // §2 开关：restartOnNodeChange=true → 新增未引用节点也即刻重启（auto-apply），不 defer。
  it('§2 开关 ON：新增未引用节点也即刻重启（不 defer）', async () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('B')], { selectedServerId: 'A', restartOnNodeChange: true });
    running(svc, a);
    const sched = jest.spyOn(svc, 'scheduleDebouncedRestart').mockImplementation(() => {});
    const b = cfg([ss('A'), ss('B'), ss('Z', '9.9.9.9')], {
      selectedServerId: 'A',
      restartOnNodeChange: true,
    });
    await svc.switchMode(b);
    expect(sched).toHaveBeenCalledTimes(1); // ON → 绕 defer 直接重启
  });

  // 切 restartOnNodeChange 开关本身（无节点变更）→ norm 排除该字段 → no-op 零重启。
  it('§2 开关：仅切开关本体（无其他变更）→ 零重启（norm 已排除）', async () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('B')], { selectedServerId: 'A', restartOnNodeChange: false });
    running(svc, a);
    const sched = jest.spyOn(svc, 'scheduleDebouncedRestart').mockImplementation(() => {});
    const b = cfg([ss('A'), ss('B')], { selectedServerId: 'A', restartOnNodeChange: true });
    await svc.switchMode(b);
    expect(sched).not.toHaveBeenCalled(); // 切开关不触发重启
  });

  it('§2 dirty 闸门：切到「已编辑未生效」节点 → 退回重启（防热切到旧参数）', async () => {
    const svc = makeSvc();
    // 运行核起于 A(选中)+Z(9.9.9.9)。快照运行核指纹。
    const started = cfg([ss('A'), ss('Z', '9.9.9.9')], { selectedServerId: 'A' });
    running(svc, started);
    svc.runningServersFingerprint = svc.computeServersFingerprint(started.servers);
    const sched = jest.spyOn(svc, 'scheduleDebouncedRestart').mockImplementation(() => {});
    // 先编辑未引用 Z（defer，currentConfig 更新，Z 变 dirty）→ 再选中 Z。
    const edited = cfg([ss('A'), ss('Z', '5.5.5.5')], { selectedServerId: 'A' });
    await svc.switchMode(edited); // 编辑 defer
    expect(sched).not.toHaveBeenCalled();
    // 现在切到 dirty 的 Z：planHotSwitch dirty 闸门 → 退回重启（否则热切到运行核里的旧 9.9.9.9）。
    const selectDirty = cfg([ss('A'), ss('Z', '5.5.5.5')], { selectedServerId: 'Z' });
    await svc.switchMode(selectDirty);
    expect(sched).toHaveBeenCalledTimes(1);
  });

  // review F1（Medium-High 回归）：规则目标改到 dirty 节点。selectedServerId 不变、Z 编辑后 targetServerId 出 norm →
  //   norm 相等 → 修前被 no-op 腿误吞（不重启、规则走旧目标、不自愈）。planRuleHotSwitch dirty→null→mustRestart 修复。
  it('§2 F1：规则目标改到「已编辑未生效」节点 → 强制重启（不被 no-op/canSkip 吞）', async () => {
    const svc = makeSvc();
    // 运行核起于 A(选中)+Z(9.9.9.9)，规则 r1 指向 A。快照运行核指纹。
    const r1: Rule = {
      id: 'r1',
      type: 'domainSuffix',
      values: ['x.com'],
      action: 'proxy',
      enabled: true,
      targetServerId: 'A',
    };
    const started = cfg([ss('A'), ss('Z', '9.9.9.9')], {
      selectedServerId: 'A',
      customRules: [r1],
    });
    running(svc, started);
    svc.runningServersFingerprint = svc.computeServersFingerprint(started.servers);
    // 运行核起时 r1 生成 rule-sel（planRuleHotSwitch 靠此 map 识别规则目标变更；缺则短路返 []）。
    svc.currentRuleTargetMap = new Map([
      ['custom:r1', { selectorTag: 'rule-sel-r1', memberTag: 'tag-A' }],
    ]);
    const sched = jest.spyOn(svc, 'scheduleDebouncedRestart').mockImplementation(() => {});
    // 步1 编辑未引用 Z（r1 仍指 A、选中 A → Z 未引用）→ defer，Z 变 dirty。
    const edited = cfg([ss('A'), ss('Z', '5.5.5.5')], {
      selectedServerId: 'A',
      customRules: [r1],
    });
    await svc.switchMode(edited);
    expect(sched).not.toHaveBeenCalled();
    // 步2 把 r1 目标 A→Z（dirty）。selectedServerId 不变、norm 相等（targetServerId 出 norm、servers 同）→
    //   planRuleHotSwitch dirty 拒热切 null → mustRestart → 跳过 no-op/canSkip → 重启。修前此处静默不生效。
    const ruleToDirty = cfg([ss('A'), ss('Z', '5.5.5.5')], {
      selectedServerId: 'A',
      customRules: [{ ...r1, targetServerId: 'Z' }],
    });
    await svc.switchMode(ruleToDirty);
    expect(sched).toHaveBeenCalledTimes(1);
  });
});

describe('§2 待应用差集 — getPendingNodeChanges 仅报未引用（review Low-1）', () => {
  it('核未运行（无快照）→ 空差集', () => {
    const svc = makeSvc();
    const c = cfg([ss('A')], { selectedServerId: 'A' });
    expect(svc.getPendingNodeChanges(c)).toEqual({ added: [], modified: [] });
  });

  it('测速 probe.isDirty（review F-B）：比传入待测节点指纹 vs 快照，不依赖 currentConfig', () => {
    const svc = makeSvc();
    const started = cfg([ss('A'), ss('Z', '9.9.9.9')], { selectedServerId: 'A' });
    svc.runningServersFingerprint = svc.computeServersFingerprint(started.servers);
    // 关键：currentConfig 停在旧参数（模拟订阅 OFF 自动刷新不经 switchMode → currentConfig 滞后）。
    svc.currentConfig = started;
    const probe = svc.getSpeedTestMainCoreProbe();
    // 待测节点（来自 ConfigManager 最新 config）参数已变 → dirty=true（即便 currentConfig 仍旧）。
    expect(probe.isDirty(ss('Z', '5.5.5.5'))).toBe(true);
    // 参数与快照一致 → 非 dirty。
    expect(probe.isDirty(ss('Z', '9.9.9.9'))).toBe(false);
    // 不在快照（新增未入核）→ false（由 hasTag/notInPool 既有判据挡）。
    expect(probe.isDirty(ss('N', '1.2.3.4'))).toBe(false);
  });

  it('被引用节点（选中/规则目标）的改/增剔除；未引用的改/增保留；删除不入差集（F-2）', () => {
    const svc = makeSvc();
    svc.getStatus = () => ({ running: true }) as never; // F-3：差集拉取需核运行（夹具无 pid → 默认 false）
    const r1: Rule = {
      id: 'r1',
      type: 'domainSuffix',
      values: ['x.com'],
      action: 'proxy',
      enabled: true,
      targetServerId: 'B',
    };
    // 运行核起于 A(选中)+B(规则目标)+Z(未引用)+Del(未引用)。快照。
    const started = cfg([ss('A'), ss('B'), ss('Z', '9.9.9.9'), ss('Del')], {
      selectedServerId: 'A',
      customRules: [r1],
    });
    svc.runningServersFingerprint = svc.computeServersFingerprint(started.servers);
    // 改选中 A（引用）+ 改规则目标 B（引用）+ 改未引用 Z + 新增未引用 N + 删未引用 Del。
    const next = cfg(
      [ss('A', '8.8.8.8'), ss('B', '7.7.7.7'), ss('Z', '5.5.5.5'), ss('N', '1.2.3.4')],
      {
        selectedServerId: 'A',
        customRules: [r1],
      }
    );
    const diff = svc.getPendingNodeChanges(next);
    expect(diff.modified.sort()).toEqual(['Z']); // A/B 被引用（即刻重启）剔除；Z 未引用保留
    expect(diff.added).toEqual(['N']); // N 未引用新增
    // F-2：Del 删除不入差集（既不在 added/modified，removed 已移除）——删被引用恒重启仅瞬态、删未引用 orphan 无语义。
    expect(Object.keys(diff)).toEqual(['added', 'modified']);
    expect(diff.added).not.toContain('Del');
    expect(diff.modified).not.toContain('Del');
  });

  it('F-3：核未运行（有陈旧快照但 running=false）→ 空差集（死核 guard）', () => {
    const svc = makeSvc();
    // 模拟崩溃终态：快照未清但核已停。
    svc.runningServersFingerprint = svc.computeServersFingerprint([ss('A'), ss('Z')]);
    svc.getStatus = () => ({ running: false }) as never;
    const next = cfg([ss('A')], { selectedServerId: 'A' });
    expect(svc.getPendingNodeChanges(next)).toEqual({ added: [], modified: [] }); // running=false → 空
  });
});
