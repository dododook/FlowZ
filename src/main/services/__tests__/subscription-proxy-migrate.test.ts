/**
 * 订阅代理策略迁移单测：旧布尔 subscriptionUpdateViaProxy（已发布字段 @4eccd59）→ 新三态 subscriptionProxyPolicy。
 * 经 loadConfig 真实路径验证（与 migrateFakeIpToggle 测试同范式）。
 * 关键不变量：旧 true→'proxy'（保住「订阅经代理」意图，防被墙订阅升级后静默退化直连）；旧 false→落回默认 follow；
 * 不覆盖用户升级后手动设的新值；消化后删旧字段（不双字段共存）；幂等。
 */

// electron mock 必须在 import 之前
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-subproxy-migrate-'));
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

/** 最小可校验 UserConfig（够过 validateConfig），默认不含 subscriptionProxyPolicy（模拟存量）。 */
function makeConfig(over: Record<string, unknown> = {}): UserConfig {
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

describe('migrateSubscriptionProxyPolicy（经 loadConfig 真实路径）', () => {
  let dir: string;
  function write(config: UserConfig): string {
    const p = path.join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify(config, null, 2));
    return p;
  }
  function read(p: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-subproxy-migrate-cfg-'));
  });

  it('存量旧 true（订阅经代理）+ 无新字段 → 迁移为 proxy + 删旧字段（含落盘）', async () => {
    const p = write(makeConfig({ subscriptionUpdateViaProxy: true }));
    const loaded = await new ConfigManager(p).loadConfig();
    expect(loaded.subscriptionProxyPolicy).toBe('proxy');
    expect(
      (loaded as unknown as Record<string, unknown>).subscriptionUpdateViaProxy
    ).toBeUndefined();
    // best-effort 落盘（迁移内 fire-and-forget；给一拍）
    await new Promise((r) => setTimeout(r, 30));
    const onDisk = read(p);
    expect(onDisk.subscriptionProxyPolicy).toBe('proxy');
    expect(onDisk.subscriptionUpdateViaProxy).toBeUndefined();
  });

  it('存量旧 false（直连）→ 删旧字段、落回默认 follow（不写新字段，求值缺省=follow）', async () => {
    const p = write(makeConfig({ subscriptionUpdateViaProxy: false }));
    const loaded = await new ConfigManager(p).loadConfig();
    expect(loaded.subscriptionProxyPolicy).toBeUndefined();
    expect(
      (loaded as unknown as Record<string, unknown>).subscriptionUpdateViaProxy
    ).toBeUndefined();
  });

  it('旧 true 但用户升级后已手动设新值 direct → 保留 direct（不覆盖）+ 删旧字段', async () => {
    const p = write(
      makeConfig({ subscriptionUpdateViaProxy: true, subscriptionProxyPolicy: 'direct' })
    );
    const loaded = await new ConfigManager(p).loadConfig();
    expect(loaded.subscriptionProxyPolicy).toBe('direct');
    expect(
      (loaded as unknown as Record<string, unknown>).subscriptionUpdateViaProxy
    ).toBeUndefined();
  });

  it('新装（无旧字段，新字段 follow）→ 原样保留、幂等不动', async () => {
    const p = write(makeConfig({ subscriptionProxyPolicy: 'follow' }));
    const loaded = await new ConfigManager(p).loadConfig();
    expect(loaded.subscriptionProxyPolicy).toBe('follow');
    expect(
      (loaded as unknown as Record<string, unknown>).subscriptionUpdateViaProxy
    ).toBeUndefined();
  });

  it('幂等：旧 true→proxy 后重复加载仍 proxy、无旧字段残留', async () => {
    const p = write(makeConfig({ subscriptionUpdateViaProxy: true }));
    const loaded1 = await new ConfigManager(p).loadConfig();
    expect(loaded1.subscriptionProxyPolicy).toBe('proxy');
    await new Promise((r) => setTimeout(r, 30));
    const loaded2 = await new ConfigManager(p).loadConfig();
    expect(loaded2.subscriptionProxyPolicy).toBe('proxy');
    expect(
      (loaded2 as unknown as Record<string, unknown>).subscriptionUpdateViaProxy
    ).toBeUndefined();
  });

  it('脏值健壮：旧字段非布尔（如 "true"/1）→ 严格 ===true 判否 → 删字段、不误升 proxy', async () => {
    // 手改 / 损坏备份可注入非布尔旧值；strict === true 把它当 not-true，删字段后落回默认 follow（不误判经代理）。
    const p = write(makeConfig({ subscriptionUpdateViaProxy: 'true' }));
    const loaded = await new ConfigManager(p).loadConfig();
    expect(loaded.subscriptionProxyPolicy).toBeUndefined(); // 非真值 → 不写 proxy
    expect(
      (loaded as unknown as Record<string, unknown>).subscriptionUpdateViaProxy
    ).toBeUndefined();
  });
});

describe('validateConfig sanitize：新三态字段非法值（手改/跨设备备份导入）', () => {
  let dir: string;
  function write(config: UserConfig): string {
    const p = path.join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify(config, null, 2));
    return p;
  }
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-subproxy-sanitize-'));
  });

  it('subscriptionProxyPolicy 非法字符串 → 删除（落回默认 follow，不崩）', async () => {
    const p = write(makeConfig({ subscriptionProxyPolicy: 'bogus' }));
    const loaded = await new ConfigManager(p).loadConfig();
    expect(loaded.subscriptionProxyPolicy).toBeUndefined();
  });

  it('subscriptionProxyPolicy 合法值（proxy/direct/follow）→ 原样保留', async () => {
    for (const v of ['proxy', 'direct', 'follow'] as const) {
      const p = write(makeConfig({ subscriptionProxyPolicy: v }));
      const loaded = await new ConfigManager(p).loadConfig();
      expect(loaded.subscriptionProxyPolicy).toBe(v);
    }
  });
});
