/**
 * FakeIP 开关统一（systemProxy / TUN 行为一致）单测。
 * 本项目铁律：DNS runtime 改动 code review 判不准，须以生成物（generateSingBoxConfig 输出）+ 纯函数断言验证。
 *
 * 覆盖：
 *  A. usesFakeIp 纯看开关（各模式 × 开关值 × 缺省矩阵）——删去 proxyModeType 分支后行为统一。
 *  B. 一次性迁移 migrateFakeIpToggle（经 loadConfig 真实路径）：TUN/manual→true、systemProxy→保留现值、
 *     缺 dnsConfig 容错、幂等（重复 load 不变、置标记后用户手动改的值不被覆盖）。
 *  C. generateDnsConfig 关 FakeIP 注入 reverse_mapping:true；开 FakeIP 不注入。
 *  D. 关键不变量：迁移前后各模式 usesFakeIp 取值逐一致。
 */

// electron mock 必须在 import 之前
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-fakeip-test-'));
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

import { usesFakeIp } from '../custom-rule-files';
import { ConfigManager } from '../ConfigManager';
import { ProxyManager } from '../ProxyManager';
import type { UserConfig, ProxyModeType } from '../../../shared/types';
import { applyFakeIpTunEntry } from '../../../shared/fakeip-tun-entry';

type AnyCfg = any;

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
    subscriptionProxyPolicy: 'follow',
    mainSessionViaProxy: true,
    rememberWindowSize: false,
    enableIPv6: false,
    autoPrivacyMode: false,
    privacyPassword: '',
    customRuleSets: [],
    appRules: [],
    appRoutingEnabled: true,
    socksPort: 2081,
    httpPort: 2080,
    logLevel: 'info',
    disableLogFile: false,
    clashApiSecret: 'fixedsecret0000000000000000000000',
    uiTheme: 'system',
    ...over,
  } as unknown as UserConfig;
}

const MODES: ProxyModeType[] = ['systemProxy', 'tun', 'manual'];

describe('A. usesFakeIp 纯看开关（不分模式）', () => {
  for (const mode of MODES) {
    it(`${mode}: enableFakeIp=true → usesFakeIp true`, () => {
      const c = makeConfig({
        proxyModeType: mode,
        dnsConfig: { domesticDns: 'x', foreignDns: 'y', enableFakeIp: true } as any,
      });
      expect(usesFakeIp(c)).toBe(true);
    });
    it(`${mode}: enableFakeIp=false → usesFakeIp false`, () => {
      const c = makeConfig({
        proxyModeType: mode,
        dnsConfig: { domesticDns: 'x', foreignDns: 'y', enableFakeIp: false } as any,
      });
      expect(usesFakeIp(c)).toBe(false);
    });
  }

  it('缺 dnsConfig → 缺省 true', () => {
    const c = makeConfig({ proxyModeType: 'systemProxy', dnsConfig: undefined });
    expect(usesFakeIp(c)).toBe(true);
  });

  it('dnsConfig 存在但 enableFakeIp 缺省（undefined）→ 缺省 true', () => {
    const c = makeConfig({
      proxyModeType: 'tun',
      dnsConfig: { domesticDns: 'x', foreignDns: 'y' } as any,
    });
    expect(usesFakeIp(c)).toBe(true);
  });
});

describe('B. 一次性迁移 migrateFakeIpToggle（经 loadConfig 真实路径）', () => {
  let dir: string;
  function write(config: UserConfig): string {
    const p = path.join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify(config, null, 2));
    return p;
  }
  function read(p: string): UserConfig {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-fakeip-migrate-'));
  });

  it('TUN 存量 enableFakeIp:false（旧默认）→ 迁移为 true + 标记 true', async () => {
    const p = write(
      makeConfig({
        proxyModeType: 'tun',
        dnsConfig: { domesticDns: 'x', foreignDns: 'y', enableFakeIp: false } as any,
      })
    );
    const cm = new ConfigManager(p);
    const loaded = await cm.loadConfig();
    expect(loaded.dnsConfig?.enableFakeIp).toBe(true);
    expect((loaded.dnsConfig as any)?.fakeIpToggleMigrated).toBe(true);
    // best-effort 落盘（saveConfig 在迁移内 fire-and-forget；给一拍让其完成）
    await new Promise((r) => setTimeout(r, 30));
    const onDisk = read(p);
    expect(onDisk.dnsConfig?.enableFakeIp).toBe(true);
    expect((onDisk.dnsConfig as any)?.fakeIpToggleMigrated).toBe(true);
  });

  it('manual 存量 enableFakeIp:false → 迁移为 true', async () => {
    const p = write(
      makeConfig({
        proxyModeType: 'manual',
        dnsConfig: { domesticDns: 'x', foreignDns: 'y', enableFakeIp: false } as any,
      })
    );
    const loaded = await new ConfigManager(p).loadConfig();
    expect(loaded.dnsConfig?.enableFakeIp).toBe(true);
    expect((loaded.dnsConfig as any)?.fakeIpToggleMigrated).toBe(true);
  });

  it('systemProxy 存量 enableFakeIp:false → 保留 false（零变化）', async () => {
    const p = write(
      makeConfig({
        proxyModeType: 'systemProxy',
        dnsConfig: { domesticDns: 'x', foreignDns: 'y', enableFakeIp: false } as any,
      })
    );
    const loaded = await new ConfigManager(p).loadConfig();
    expect(loaded.dnsConfig?.enableFakeIp).toBe(false);
    expect((loaded.dnsConfig as any)?.fakeIpToggleMigrated).toBe(true);
  });

  it('systemProxy 存量 dnsConfig 存在但 enableFakeIp 字段缺失（undefined）→ 迁移冻结为 false（与旧 effective 一致）', async () => {
    // P2：旧 systemProxy effective = !!enableFakeIp = false；不冻结则新 usesFakeIp 的「?? true」把 undefined 翻成 on，
    // 与「缺 dnsConfig（systemProxy）显式写 false」自相矛盾。冻结后两分支语义一致、零变化。
    const p = write(
      makeConfig({
        proxyModeType: 'systemProxy',
        dnsConfig: { domesticDns: 'x', foreignDns: 'y' } as any, // enableFakeIp 字段缺失
      })
    );
    const loaded = await new ConfigManager(p).loadConfig();
    expect(loaded.dnsConfig?.enableFakeIp).toBe(false);
    expect((loaded.dnsConfig as any)?.fakeIpToggleMigrated).toBe(true);
    expect(usesFakeIp(loaded)).toBe(false); // 与旧 systemProxy effective(false) 一致，零变化
  });

  it('systemProxy 存量 enableFakeIp:true → 保留 true', async () => {
    const p = write(
      makeConfig({
        proxyModeType: 'systemProxy',
        dnsConfig: { domesticDns: 'x', foreignDns: 'y', enableFakeIp: true } as any,
      })
    );
    const loaded = await new ConfigManager(p).loadConfig();
    expect(loaded.dnsConfig?.enableFakeIp).toBe(true);
    expect((loaded.dnsConfig as any)?.fakeIpToggleMigrated).toBe(true);
  });

  it('缺 dnsConfig（TUN）→ 补默认 + enableFakeIp=true + 标记，不抛', async () => {
    const p = write(makeConfig({ proxyModeType: 'tun', dnsConfig: undefined }));
    const loaded = await new ConfigManager(p).loadConfig();
    expect(loaded.dnsConfig).toBeDefined();
    expect(loaded.dnsConfig?.enableFakeIp).toBe(true);
    expect((loaded.dnsConfig as any)?.fakeIpToggleMigrated).toBe(true);
  });

  it('缺 dnsConfig（systemProxy）→ 补默认 + enableFakeIp=false（无现值，回落开关默认）+ 标记', async () => {
    const p = write(makeConfig({ proxyModeType: 'systemProxy', dnsConfig: undefined }));
    const loaded = await new ConfigManager(p).loadConfig();
    expect(loaded.dnsConfig?.enableFakeIp).toBe(false);
    expect((loaded.dnsConfig as any)?.fakeIpToggleMigrated).toBe(true);
  });

  it('幂等：已迁移（标记 true）的 systemProxy 配置 enableFakeIp:true 不被改写', async () => {
    const p = write(
      makeConfig({
        proxyModeType: 'systemProxy',
        dnsConfig: {
          domesticDns: 'x',
          foreignDns: 'y',
          enableFakeIp: true,
          fakeIpToggleMigrated: true,
        } as any,
      })
    );
    const loaded = await new ConfigManager(p).loadConfig();
    expect(loaded.dnsConfig?.enableFakeIp).toBe(true);
  });

  it('幂等：用户迁移后手动把 TUN 关到 false（已标记）→ 重复加载不被改回 true', async () => {
    const p = write(
      makeConfig({
        proxyModeType: 'tun',
        dnsConfig: {
          domesticDns: 'x',
          foreignDns: 'y',
          enableFakeIp: false, // 用户迁移后手动关
          fakeIpToggleMigrated: true,
        } as any,
      })
    );
    const loaded1 = await new ConfigManager(p).loadConfig();
    expect(loaded1.dnsConfig?.enableFakeIp).toBe(false); // 标记已 true → 不改写
    await new Promise((r) => setTimeout(r, 30));
    const loaded2 = await new ConfigManager(p).loadConfig();
    expect(loaded2.dnsConfig?.enableFakeIp).toBe(false); // 重复加载仍不变
  });

  it('幂等：迁移后重复加载 enableFakeIp 不再变化（TUN 旧 false→迁 true→再 load 仍 true）', async () => {
    const p = write(
      makeConfig({
        proxyModeType: 'tun',
        dnsConfig: { domesticDns: 'x', foreignDns: 'y', enableFakeIp: false } as any,
      })
    );
    const loaded1 = await new ConfigManager(p).loadConfig();
    expect(loaded1.dnsConfig?.enableFakeIp).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    const loaded2 = await new ConfigManager(p).loadConfig();
    expect(loaded2.dnsConfig?.enableFakeIp).toBe(true);
    expect((loaded2.dnsConfig as any)?.fakeIpToggleMigrated).toBe(true);
  });
});

describe('D. 关键不变量：迁移前后各模式 usesFakeIp 取值逐一致', () => {
  // 旧 usesFakeIp 语义（改前）：非 systemProxy 恒 true；systemProxy 看开关。
  function oldUsesFakeIp(config: UserConfig): boolean {
    return config.proxyModeType?.toLowerCase() !== 'systemproxy'
      ? true
      : !!config.dnsConfig?.enableFakeIp;
  }

  it('TUN 存量 enableFakeIp:false：改前 true → 迁移后 enableFakeIp=true → 新 usesFakeIp true（零变化）', () => {
    const before = makeConfig({
      proxyModeType: 'tun',
      dnsConfig: { domesticDns: 'x', foreignDns: 'y', enableFakeIp: false } as any,
    });
    expect(oldUsesFakeIp(before)).toBe(true);
    // 迁移把 enableFakeIp 写 true
    const after = makeConfig({
      proxyModeType: 'tun',
      dnsConfig: { domesticDns: 'x', foreignDns: 'y', enableFakeIp: true } as any,
    });
    expect(usesFakeIp(after)).toBe(true); // 与迁移前 oldUsesFakeIp 一致
  });

  it('systemProxy 存量：改前后都看开关现值（迁移保留，零变化）', () => {
    for (const v of [true, false]) {
      const c = makeConfig({
        proxyModeType: 'systemProxy',
        dnsConfig: { domesticDns: 'x', foreignDns: 'y', enableFakeIp: v } as any,
      });
      expect(oldUsesFakeIp(c)).toBe(v);
      expect(usesFakeIp(c)).toBe(v); // 迁移保留现值 → 新旧一致
    }
  });
});

describe('C. generateDnsConfig：关 FakeIP 注入 reverse_mapping；开则不注入', () => {
  const pm = new ProxyManager();
  const NODE = {
    id: 'n1',
    name: 'n1',
    protocol: 'vless',
    address: 'a.example.com',
    port: 443,
    uuid: '00000000-0000-0000-0000-00000000000a',
    tlsSettings: { serverName: 'a.example.com' },
  };

  function genDns(enableFakeIp: boolean, proxyModeType: ProxyModeType = 'tun'): AnyCfg {
    const cfg = makeConfig({
      proxyModeType,
      proxyMode: 'smart',
      servers: [NODE as any],
      selectedServerId: 'n1',
      dnsConfig: { domesticDns: 'x', foreignDns: 'y', enableFakeIp } as any,
    });
    return (pm.generateSingBoxConfig(cfg) as AnyCfg).dns;
  }

  it('关 FakeIP：dns.reverse_mapping === true，且无 fakeip server/规则', () => {
    const dns = genDns(false);
    expect(dns.reverse_mapping).toBe(true);
    expect((dns.servers as AnyCfg[]).some((s) => s.tag === 'fakeip')).toBe(false);
    expect((dns.rules as AnyCfg[]).some((r) => r.server === 'fakeip')).toBe(false);
  });

  it('开 FakeIP：不注入 reverse_mapping（undefined），且含 fakeip server/规则', () => {
    const dns = genDns(true);
    expect(dns.reverse_mapping).toBeUndefined();
    expect((dns.servers as AnyCfg[]).some((s) => s.tag === 'fakeip')).toBe(true);
    expect((dns.rules as AnyCfg[]).some((r) => r.server === 'fakeip')).toBe(true);
  });

  it('systemProxy 关 FakeIP 同样注入 reverse_mapping（统一行为）', () => {
    const dns = genDns(false, 'systemProxy');
    expect(dns.reverse_mapping).toBe(true);
  });
});

describe('E. migrateFakeIpTunPending 评估（经 loadConfig 真实路径）', () => {
  let dir: string;
  function write(config: any): string {
    const p = path.join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify(config, null, 2));
    return p;
  }
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-fakeip-tunpending-'));
  });

  it('systemProxy 存量 enableFakeIp:false → 判迁移冻结，fakeIpTunAutoEnable:true', async () => {
    const p = write(
      makeConfig({
        proxyModeType: 'systemProxy',
        dnsConfig: { domesticDns: 'x', foreignDns: 'y', enableFakeIp: false } as any,
      })
    );
    const loaded = await new ConfigManager(p).loadConfig();
    expect(loaded.dnsConfig?.enableFakeIp).toBe(false); // migrateFakeIpToggle 保留
    expect((loaded.dnsConfig as any)?.fakeIpTunAutoEnable).toBe(true); // 待纠正
  });

  it("TUN 手动关（tun+false+已 migrated）→ 不植 flag（不误伤 A'）", async () => {
    const p = write(
      makeConfig({
        proxyModeType: 'tun',
        dnsConfig: {
          domesticDns: 'x',
          foreignDns: 'y',
          enableFakeIp: false,
          fakeIpToggleMigrated: true,
        } as any,
      })
    );
    const loaded = await new ConfigManager(p).loadConfig();
    expect(loaded.dnsConfig?.enableFakeIp).toBe(false); // migrated 幂等跳过，保留用户关闭
    expect((loaded.dnsConfig as any)?.fakeIpTunAutoEnable).toBe(false);
  });

  it('manual + false + 已 migrated → 不植 flag（非 systemProxy）', async () => {
    const p = write(
      makeConfig({
        proxyModeType: 'manual',
        dnsConfig: {
          domesticDns: 'x',
          foreignDns: 'y',
          enableFakeIp: false,
          fakeIpToggleMigrated: true,
        } as any,
      })
    );
    const loaded = await new ConfigManager(p).loadConfig();
    expect((loaded.dnsConfig as any)?.fakeIpTunAutoEnable).toBe(false);
  });

  it('systemProxy + enableFakeIp:true → 不植 flag（enableFakeIp 非 false）', async () => {
    const p = write(
      makeConfig({
        proxyModeType: 'systemProxy',
        dnsConfig: { domesticDns: 'x', foreignDns: 'y', enableFakeIp: true } as any,
      })
    );
    const loaded = await new ConfigManager(p).loadConfig();
    expect((loaded.dnsConfig as any)?.fakeIpTunAutoEnable).toBe(false);
  });

  it('幂等/防跨重启泄漏：已评估否决（false）→ 再 load 不复植 true', async () => {
    const p = write(
      makeConfig({
        proxyModeType: 'systemProxy',
        dnsConfig: {
          domesticDns: 'x',
          foreignDns: 'y',
          enableFakeIp: false,
          fakeIpToggleMigrated: true,
          fakeIpTunAutoEnable: false,
        } as any,
      })
    );
    const loaded = await new ConfigManager(p).loadConfig();
    expect((loaded.dnsConfig as any)?.fakeIpTunAutoEnable).toBe(false);
  });

  it('中间版本升级主路径：已 migrated + flag undefined + systemProxy+false → 判 true', async () => {
    const p = write(
      makeConfig({
        proxyModeType: 'systemProxy',
        dnsConfig: {
          domesticDns: 'x',
          foreignDns: 'y',
          enableFakeIp: false,
          fakeIpToggleMigrated: true,
        } as any,
      })
    );
    const loaded = await new ConfigManager(p).loadConfig();
    expect((loaded.dnsConfig as any)?.fakeIpTunAutoEnable).toBe(true);
  });

  it('已植 true → 再 load 幂等保持 true（存续到消费，不被重评估掉）', async () => {
    const p = write(
      makeConfig({
        proxyModeType: 'systemProxy',
        dnsConfig: {
          domesticDns: 'x',
          foreignDns: 'y',
          enableFakeIp: false,
          fakeIpToggleMigrated: true,
          fakeIpTunAutoEnable: true,
        } as any,
      })
    );
    const loaded = await new ConfigManager(p).loadConfig();
    expect((loaded.dnsConfig as any)?.fakeIpTunAutoEnable).toBe(true);
  });

  it('新装无配置文件 → createDefaultConfig flag:false', async () => {
    const p = path.join(dir, `nonexistent-${Math.random().toString(36).slice(2)}.json`);
    const loaded = await new ConfigManager(p).loadConfig();
    expect((loaded.dnsConfig as any)?.fakeIpTunAutoEnable).toBe(false);
  });
});

describe('G. 端到端序列：冻结用户生命周期不复发（核心回归护栏）', () => {
  let dir: string;
  function write(config: any): string {
    const p = path.join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify(config, null, 2));
    return p;
  }
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-fakeip-seq-'));
  });

  it('植 flag→切 TUN 纠正→手动关→切回 systemProxy→再进 TUN 保持关（尊重意图，不复发）', async () => {
    // 1) 存量 systemProxy+false 升级：评估植 flag
    const p = write(
      makeConfig({
        proxyModeType: 'systemProxy',
        dnsConfig: { domesticDns: 'x', foreignDns: 'y', enableFakeIp: false } as any,
      })
    );
    const cm = new ConfigManager(p);
    const loaded = await cm.loadConfig();
    expect((loaded.dnsConfig as any)?.fakeIpTunAutoEnable).toBe(true);

    // 2) 切 TUN：消费，enableFakeIp 回 true
    const entered = applyFakeIpTunEntry({ ...loaded, proxyModeType: 'tun' });
    expect(entered.corrected).toBe(true);
    expect(entered.config.dnsConfig!.enableFakeIp).toBe(true);
    expect(entered.config.dnsConfig!.fakeIpTunAutoEnable).toBe(false);

    // 3) 用户在 TUN 下手动关 FakeIP（writeFakeIp 效果：enableFakeIp false + flag false），落盘
    const manualOff = {
      ...entered.config,
      dnsConfig: { ...entered.config.dnsConfig!, enableFakeIp: false, fakeIpTunAutoEnable: false },
    };
    await cm.saveConfig(manualOff as any);

    // 4) 切回 systemProxy 再启动：不复植 flag（已 false，非 undefined）
    await cm.saveConfig({ ...manualOff, proxyModeType: 'systemProxy' } as any);
    const reloaded = await cm.loadConfig();
    expect((reloaded.dnsConfig as any)?.fakeIpTunAutoEnable).toBe(false);

    // 5) 再进 TUN：不纠正（尊重用户主动关）
    const reentered = applyFakeIpTunEntry({ ...reloaded, proxyModeType: 'tun' });
    expect(reentered.corrected).toBe(false);
    expect(reentered.config.dnsConfig!.enableFakeIp).toBe(false);
  });
});
