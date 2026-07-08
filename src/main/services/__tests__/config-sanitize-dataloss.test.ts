/**
 * ConfigManager 数据丢失防线 sanitize 单测。
 *
 * 背景：loadConfig 的 catch 兜底会用默认配置覆盖落盘 config.json（validateConfig 任一 throw 即触发），
 * 静默清空用户全部 servers/订阅/规则且无备份。收口策略：把「单个坏值」（坏节点/坏订阅/悬空 selectedServerId）
 * 由 throw 改为逐项 sanitize（剔除坏项、保住其余），使 validateConfig 不再因单条脏数据 throw 整份。
 *
 * 覆盖：
 *  1. 坏节点（未知协议 / anytls 无密码 / 缺 address / 缺 id）剔除，合法节点保留（不丢全量）。
 *  2. 坏订阅（缺 id/name/url）剔除，合法订阅保留。
 *  3. 悬空 selectedServerId（指向被剔除/根本不存在的节点）→ 归 null；类型非法 → 归 null；合法/哨兵不动。
 *  4. Tailscale 单节点硬限去重：保留第一个 TS、丢弃其余；selectedServerId 指向被丢弃 TS → 归 null。
 *  5. set() 未加载守卫：currentConfig===null 时先 loadConfig 加载磁盘真实配置再改单键，不以默认覆盖落盘。
 *
 * 测试构造：validateConfig 公开实例方法、不读盘，直接构造 ConfigManager（同 config-lan-exclude.test.ts）；
 *   set() 用真实临时文件走 loadConfig→saveConfig 全路径。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-config-sanitize-'));

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

import { ConfigManager } from '../ConfigManager';
import type { UserConfig } from '../../../shared/types';

/** 合法 vless 节点（够过 validateConfig，不被 sanitize 剔除）。 */
function goodServer(over: Record<string, unknown> = {}): any {
  return {
    id: 'good-1',
    name: 'HK-01',
    protocol: 'vless',
    address: 'a.example.com',
    port: 443,
    uuid: '00000000-0000-0000-0000-00000000000a',
    ...over,
  };
}

/** 最小合法 UserConfig（其余字段补默认避免无关分支 throw），按需覆盖。 */
function makeConfig(over: Partial<UserConfig> = {}): UserConfig {
  return {
    subscriptions: [],
    servers: [],
    selectedServerId: null,
    proxyMode: 'smart',
    proxyModeType: 'systemProxy',
    tunConfig: { mtu: 1350, stack: 'system', autoRoute: true, strictRoute: true },
    customRules: [],
    autoStart: false,
    silentStart: false,
    autoConnect: false,
    minimizeToTray: false,
    mixedPort: 7890,
    logLevel: 'info',
    ...over,
  } as unknown as UserConfig;
}

describe('validateConfig sanitize（坏值剔除，防整配置回落默认丢全量）', () => {
  let cm: ConfigManager;
  beforeEach(() => {
    cm = new ConfigManager(path.join(TMP, `s-${Date.now()}-${Math.random()}.json`));
  });

  it('坏节点（未知协议/anytls 无密码/缺 address/缺 id）剔除，合法节点保留', () => {
    const cfg = makeConfig({
      servers: [
        goodServer({ id: 'good-1' }),
        goodServer({ id: 'bad-proto', protocol: 'ssr' }), // 未知协议
        { id: 'bad-anytls', name: 'x', protocol: 'anytls', address: 'b.com', port: 443 }, // 无 password
        { id: 'bad-addr', name: 'y', protocol: 'vmess', port: 443, uuid: 'u' }, // 缺 address
        { name: 'no-id', protocol: 'vless', address: 'c.com', port: 443, uuid: 'u' }, // 缺 id
        goodServer({ id: 'good-2', name: 'JP-02' }),
      ] as any,
    });
    expect(() => cm.validateConfig(cfg)).not.toThrow();
    expect(cfg.servers.map((s) => s.id)).toEqual(['good-1', 'good-2']); // 仅剔坏节点，合法节点全保留
  });

  it('坏订阅（缺 id/name/url）剔除，合法订阅保留', () => {
    const cfg = makeConfig({
      subscriptions: [
        { id: 'sub-1', name: 'A', url: 'https://a' },
        { id: 'sub-2', name: 'B' }, // 缺 url
        { name: 'no-id', url: 'https://x' }, // 缺 id
        { id: 'sub-3', name: 'C', url: 'https://c' },
      ] as any,
    });
    expect(() => cm.validateConfig(cfg)).not.toThrow();
    expect(cfg.subscriptions!.map((s) => s.id)).toEqual(['sub-1', 'sub-3']);
  });

  it('悬空 selectedServerId（指向被剔除的坏节点）→ 归 null，合法节点保留', () => {
    const cfg = makeConfig({
      servers: [goodServer({ id: 'good-1' }), goodServer({ id: 'bad', protocol: 'ssr' })] as any,
      selectedServerId: 'bad', // 指向将被剔除的未知协议节点
    });
    expect(() => cm.validateConfig(cfg)).not.toThrow();
    expect(cfg.selectedServerId).toBeNull();
    expect(cfg.servers.map((s) => s.id)).toEqual(['good-1']);
  });

  it('selectedServerId 指向根本不存在的节点 → 归 null（不 throw）', () => {
    const cfg = makeConfig({
      servers: [goodServer({ id: 'good-1' })] as any,
      selectedServerId: 'ghost',
    });
    expect(() => cm.validateConfig(cfg)).not.toThrow();
    expect(cfg.selectedServerId).toBeNull();
  });

  it('selectedServerId 合法（指向保留节点）→ 不动', () => {
    const cfg = makeConfig({
      servers: [goodServer({ id: 'good-1' })] as any,
      selectedServerId: 'good-1',
    });
    cm.validateConfig(cfg);
    expect(cfg.selectedServerId).toBe('good-1');
  });

  it('selectedServerId 类型非法（非 string / 非 null）→ 归 null', () => {
    const cfg = makeConfig({ servers: [], selectedServerId: 123 as any });
    expect(() => cm.validateConfig(cfg)).not.toThrow();
    expect(cfg.selectedServerId).toBeNull();
  });

  it('__direct__ 哨兵 → 豁免存在性校验，保留', () => {
    const cfg = makeConfig({ servers: [], selectedServerId: '__direct__' as any });
    cm.validateConfig(cfg);
    expect(cfg.selectedServerId).toBe('__direct__');
  });

  it('Tailscale 单节点硬限：保留第一个 TS、丢弃其余；selectedServerId 指向被丢弃 TS → 归 null', () => {
    const cfg = makeConfig({
      servers: [
        { id: 'ts-1', name: 'TS-A', protocol: 'tailscale' },
        { id: 'ts-2', name: 'TS-B', protocol: 'tailscale' },
        goodServer({ id: 'good-1' }),
      ] as any,
      selectedServerId: 'ts-2', // 指向将被去重丢弃的第二个 TS
    });
    expect(() => cm.validateConfig(cfg)).not.toThrow();
    expect(cfg.servers.map((s) => s.id)).toEqual(['ts-1', 'good-1']); // 保留首个 TS + 非 TS 节点
    expect(cfg.selectedServerId).toBeNull(); // 悬空 → 归零
  });
});

describe('set() 未加载守卫（不以默认配置覆盖磁盘真实配置）', () => {
  it('currentConfig===null 时 set() 先 loadConfig 加载磁盘真实配置再改单键，servers 不被清空', async () => {
    const p = path.join(TMP, `set-guard-${Date.now()}.json`);
    // 预置迁移完成标记 + clashApiSecret + dnsConfig，令 loadConfig 不触发任何一次性迁移的 saveConfig 落盘，
    // 加载零写放大：整个用例只发生 set() 的一次 saveConfig，避免并行跑时因写放大 + worker 饥饿超时抖动。
    const onDiskBefore = makeConfig({
      servers: [goodServer({ id: 'keep-me', name: 'HK' })] as any,
      selectedServerId: 'keep-me',
      logLevel: 'info',
      clashApiSecret: 'deadbeef',
      appRulesSeeded: true,
      tunStackMigrated: true,
      dnsConfig: {
        domesticDns: 'x',
        foreignDns: 'y',
        enableFakeIp: true,
        fakeIpToggleMigrated: true,
        fakeIpTunAutoEnable: false,
        nodeResolverMigrated: true,
      },
    } as any);
    fs.writeFileSync(p, JSON.stringify(onDiskBefore, null, 2));

    const cm = new ConfigManager(p); // 全新实例，currentConfig===null（从未 loadConfig）
    await cm.set('logLevel', 'debug');

    const after = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(after.logLevel).toBe('debug'); // 单键已改
    expect(after.servers).toHaveLength(1); // 真实节点未被默认配置覆盖清空
    expect(after.servers[0].id).toBe('keep-me');
    expect(after.selectedServerId).toBe('keep-me');
  });
});
