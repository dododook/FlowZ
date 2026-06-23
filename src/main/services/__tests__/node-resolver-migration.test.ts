/**
 * issue #147 节点域名解析器迁移 + 消费点等价单测。
 * 本项目铁律：DNS runtime 改动 code review 判不准，须以生成物/纯函数断言验证。
 *
 * 覆盖：
 *  A. migrateNodeResolver（经 loadConfig 真实路径）：旧单选档位 auto/dnspod/system → 新 pool/single 映射 +
 *     migrated 标记；旧无字段→auto 等价；幂等（已 migrated 不覆盖用户值）；新装默认。
 *  B. getNodeResolverTag 读 nodeResolverSingle 产出与旧档位【完全等价】的 tag；single 缺失回退 legacy。
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-node-resolver-test-'));
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
import { getNodeResolverTag } from '../singbox-config-helpers';
import type { UserConfig } from '../../../shared/types';

/** 最小可校验 UserConfig（够过 validateConfig），按需覆盖。 */
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
    minimizeToTray: true,
    autoCheckUpdate: true,
    autoLightweightMode: false,
    autoUpdateSubscriptionOnStart: false,
    subscriptionUpdateIntervalHours: 12,
    subscriptionUpdateViaProxy: false,
    mainSessionViaProxy: true,
    rememberWindowSize: false,
    enableIPv6: false,
    autoPrivacyMode: false,
    privacyPassword: '',
    customRuleSets: [],
    appRules: [],
    appRoutingEnabled: true,
    logLevel: 'info',
    disableLogFile: false,
    clashApiSecret: 'fixedsecret0000000000000000000000',
    uiTheme: 'system',
    ...over,
  } as unknown as UserConfig;
}

const baseDns = (over: Record<string, unknown> = {}) =>
  ({
    domesticDns: 'x',
    foreignDns: 'y',
    enableFakeIp: true,
    fakeIpToggleMigrated: true,
    ...over,
  }) as any;

describe('A. migrateNodeResolver（经 loadConfig）', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-node-resolver-migrate-'));
  });
  const write = (config: UserConfig): string => {
    const p = path.join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify(config, null, 2));
    return p;
  };

  it('旧 auto → pool[ali,dnspod] + single ali + migrated', async () => {
    const p = write(makeConfig({ dnsConfig: baseDns({ nodeDomainResolver: 'auto' }) }));
    const c = (await new ConfigManager(p).loadConfig()).dnsConfig as any;
    expect(c.nodeResolverPool).toEqual(['ali', 'dnspod']);
    expect(c.nodeResolverSingle).toBe('ali');
    expect(c.nodeResolverMigrated).toBe(true);
  });

  it('旧 dnspod → [dnspod]/dnspod（保留用户意图）', async () => {
    const p = write(makeConfig({ dnsConfig: baseDns({ nodeDomainResolver: 'dnspod' }) }));
    const c = (await new ConfigManager(p).loadConfig()).dnsConfig as any;
    expect(c.nodeResolverPool).toEqual(['dnspod']);
    expect(c.nodeResolverSingle).toBe('dnspod');
  });

  it('旧 system → [system]/system', async () => {
    const p = write(makeConfig({ dnsConfig: baseDns({ nodeDomainResolver: 'system' }) }));
    const c = (await new ConfigManager(p).loadConfig()).dnsConfig as any;
    expect(c.nodeResolverPool).toEqual(['system']);
    expect(c.nodeResolverSingle).toBe('system');
  });

  it('旧无 nodeDomainResolver 字段 → 视为 auto 等价 [ali,dnspod]/ali', async () => {
    const p = write(makeConfig({ dnsConfig: baseDns() }));
    const c = (await new ConfigManager(p).loadConfig()).dnsConfig as any;
    expect(c.nodeResolverPool).toEqual(['ali', 'dnspod']);
    expect(c.nodeResolverSingle).toBe('ali');
  });

  it('幂等：已 migrated 的用户自定义 pool/single 不被覆盖', async () => {
    const p = write(
      makeConfig({
        dnsConfig: baseDns({
          nodeDomainResolver: 'auto',
          nodeResolverPool: ['dnspod'],
          nodeResolverSingle: 'system',
          nodeResolverMigrated: true,
        }),
      })
    );
    const c = (await new ConfigManager(p).loadConfig()).dnsConfig as any;
    expect(c.nodeResolverPool).toEqual(['dnspod']);
    expect(c.nodeResolverSingle).toBe('system');
  });

  it('新装（配置文件不存在）→ 默认 pool[ali,dnspod]/single ali/migrated', async () => {
    const p = path.join(dir, 'nonexistent-default.json');
    const c = (await new ConfigManager(p).loadConfig()).dnsConfig as any;
    expect(c.nodeResolverPool).toEqual(['ali', 'dnspod']);
    expect(c.nodeResolverSingle).toBe('ali');
    expect(c.nodeResolverMigrated).toBe(true);
  });
});

describe('B. getNodeResolverTag：race on → dns-node-race；off → 单上游（等价旧档位）', () => {
  // race off（逃生/降级 / snapshot·preflight 路径）才走单上游；race server 就绪时 ProxyManager 才把 config 置 on。
  const off = (over: Record<string, unknown> = {}) =>
    baseDns({ resolveNodeDomainsAhead: false, ...over });

  it('race on（默认）→ dns-node-race（dial 与 rule 同 tag）', () => {
    const c = makeConfig({ dnsConfig: baseDns({ nodeResolverPool: ['ali', 'dnspod'] }) });
    expect(getNodeResolverTag(c, 'dial')).toBe('dns-node-race');
    expect(getNodeResolverTag(c, 'rule')).toBe('dns-node-race');
  });

  it('off + single ali → dial=dns-bootstrap / rule=dns-domestic', () => {
    const c = makeConfig({ dnsConfig: off({ nodeResolverSingle: 'ali' }) });
    expect(getNodeResolverTag(c, 'dial')).toBe('dns-bootstrap');
    expect(getNodeResolverTag(c, 'rule')).toBe('dns-domestic');
  });

  it('off + single dnspod → dns-node（dial 与 rule 同）', () => {
    const c = makeConfig({ dnsConfig: off({ nodeResolverSingle: 'dnspod' }) });
    expect(getNodeResolverTag(c, 'dial')).toBe('dns-node');
    expect(getNodeResolverTag(c, 'rule')).toBe('dns-node');
  });

  it('off + single system → dial=dns-local；TUN rule 强制 dns-node（INV-1 防递归）', () => {
    const sys = makeConfig({
      proxyModeType: 'systemProxy',
      dnsConfig: off({ nodeResolverSingle: 'system' }),
    });
    expect(getNodeResolverTag(sys, 'dial')).toBe('dns-local');
    expect(getNodeResolverTag(sys, 'rule')).toBe('dns-local');
    const tun = makeConfig({
      proxyModeType: 'tun',
      dnsConfig: off({ nodeResolverSingle: 'system' }),
    });
    expect(getNodeResolverTag(tun, 'rule')).toBe('dns-node'); // INV-1
  });

  it('off + 回退 legacy（仅 deprecated nodeDomainResolver，无 single）→ 等价旧', () => {
    expect(
      getNodeResolverTag(makeConfig({ dnsConfig: off({ nodeDomainResolver: 'dnspod' }) }), 'dial')
    ).toBe('dns-node');
    const auto = makeConfig({ dnsConfig: off({ nodeDomainResolver: 'auto' }) });
    expect(getNodeResolverTag(auto, 'dial')).toBe('dns-bootstrap');
    expect(getNodeResolverTag(auto, 'rule')).toBe('dns-domestic');
  });

  it('off + 自定义 single → 当前回退基线 tag（off+自定义单上游 server 生成为 §E 二期）', () => {
    const c = makeConfig({ dnsConfig: off({ nodeResolverSingle: 'custom-xxx' }) });
    expect(getNodeResolverTag(c, 'dial')).toBe('dns-bootstrap');
  });
});
