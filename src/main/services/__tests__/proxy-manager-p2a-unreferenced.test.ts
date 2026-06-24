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
    const svc = makeSvc();
    const c = cfg(
      [ss('A', '1.1.1.1', { detour: 'B' }), ss('B', '2.2.2.2', { detour: 'C' }), ss('C'), ss('D')],
      {
        selectedServerId: 'A',
      }
    );
    const R = svc.referencedServerIds(c);
    expect([...R].sort()).toEqual(['A', 'B', 'C']); // D 是无关纯代理，不纳入
  });

  it('规则目标（custom + app）及其 detour 链纳入', () => {
    const svc = makeSvc();
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
    const R = svc.referencedServerIds(c);
    // A(选中) + C(custom 目标)+B(C 的前置) + D(app 目标)
    expect([...R].sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('所有 endpoint（WG/TS）一律保守纳入（独立于选中）', () => {
    const svc = makeSvc();
    const c = cfg([ss('A'), ss('B'), wg('wg1')], { selectedServerId: 'A' });
    const R = svc.referencedServerIds(c);
    expect(R.has('wg1')).toBe(true); // 未选中的 endpoint 也纳入
    expect(R.has('B')).toBe(false); // 未选中的纯代理不纳入
  });

  it('direct 哨兵选中 → 不 seed；禁用规则目标 / 悬空 detour / 成环均安全', () => {
    const svc = makeSvc();
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
    const R = svc.referencedServerIds(c);
    expect(R.size).toBe(0); // 无 endpoint、选中=direct、规则禁用 → 空集（成环/悬空 detour 不死循环不抛）
  });
});

describe('issue #176 P2-A — configGenerationNorm(serverIds) 过滤', () => {
  it('传 serverIds → servers 仅保留指定节点；空集 → 仅非节点字段', () => {
    const svc = makeSvc();
    const c = cfg([ss('A'), ss('B'), ss('C')], { selectedServerId: 'A' });
    expect(
      JSON.parse(svc.configGenerationNorm(c, new Set(['A']))).servers.map((s: any) => s.id)
    ).toEqual(['A']);
    expect(JSON.parse(svc.configGenerationNorm(c, new Set())).servers).toEqual([]); // 空集=非节点字段对比
  });
});

describe('issue #176 P2-A — canSkipRestartForAddedUnreferenced 非对称安全判据', () => {
  it('纯新增未引用纯代理节点 → 可免重启', () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('B')], { selectedServerId: 'A' });
    const b = cfg([ss('A'), ss('B'), ss('Z', '9.9.9.9')], { selectedServerId: 'A' });
    expect(svc.canSkipRestartForAddedUnreferenced(a, b)).toBe(true);
  });

  it('删除未引用节点 → 仍重启（残留陈旧 route 排除/DNS 条目，旧址复用可致错误直连）', () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('B'), ss('Z')], { selectedServerId: 'A' });
    const b = cfg([ss('A'), ss('B')], { selectedServerId: 'A' });
    expect(svc.canSkipRestartForAddedUnreferenced(a, b)).toBe(false);
  });

  it('改未引用节点 address → 仍重启（H1：route 排除/DNS rule1 遍历全节点 address，残留陈旧）', () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('Z', '9.9.9.9')], { selectedServerId: 'A' });
    const b = cfg([ss('A'), ss('Z', '5.5.5.5')], { selectedServerId: 'A' }); // Z 地址变
    expect(svc.canSkipRestartForAddedUnreferenced(a, b)).toBe(false);
  });

  it('改未引用节点任一参数（同址）→ 仍重启（保守：旧节点须逐字节不变）', () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('Z', '9.9.9.9', { port: 8388 })], { selectedServerId: 'A' });
    const b = cfg([ss('A'), ss('Z', '9.9.9.9', { port: 9999 })], { selectedServerId: 'A' }); // Z 端口变
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

  it('删未引用节点 → 仍重启（H1 修正：残留陈旧 route/DNS 条目，不能免重启）', async () => {
    const svc = makeSvc();
    const a = cfg([ss('A'), ss('B'), ss('Z')], { selectedServerId: 'A' });
    running(svc, a);
    const sched = jest.spyOn(svc, 'scheduleDebouncedRestart').mockImplementation(() => {});
    const b = cfg([ss('A'), ss('B')], { selectedServerId: 'A' }); // 删 Z
    await svc.switchMode(b);
    expect(sched).toHaveBeenCalledTimes(1);
  });
});
