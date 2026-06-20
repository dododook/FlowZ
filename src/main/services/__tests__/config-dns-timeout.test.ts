/**
 * P2c dnsConfig.dnsTimeoutMs sanitize 单测（validateConfig）。
 * 约定：dnsTimeoutMs 必为有限正整数且 ∈ [1, 60000]ms，否则删除该字段（回落核默认，不下发 dns.timeout）；
 *   小数四舍五入为整数。一律不 throw（与 CIDR/规则 sanitize 同标准，防单条脏值触发整配置回落）。
 *
 * 测试构造：validateConfig 公开实例方法、不读盘，直接构造 ConfigManager 调用（同 config-control-port.test.ts）。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-dns-timeout-'));

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

function makeConfig(dnsTimeoutMs: unknown): UserConfig {
  return {
    subscriptions: [],
    servers: [],
    selectedServerId: null,
    proxyMode: 'smart',
    proxyModeType: 'systemProxy',
    mixedPort: 7890,
    tunConfig: { mtu: 1350, stack: 'system', autoRoute: true, strictRoute: true },
    customRules: [],
    autoStart: false,
    silentStart: false,
    autoConnect: false,
    minimizeToTray: false,
    logLevel: 'info',
    dnsConfig: { domesticDns: '', foreignDns: '', enableFakeIp: false, dnsTimeoutMs },
  } as unknown as UserConfig;
}

describe('dnsConfig.dnsTimeoutMs sanitize（P2c）', () => {
  let cm: ConfigManager;
  beforeEach(() => {
    cm = new ConfigManager(path.join(TMP, `dt-${Date.now()}-${Math.random()}.json`));
  });

  it('有效整数 → 保留', () => {
    const cfg = makeConfig(5000);
    cm.validateConfig(cfg);
    expect(cfg.dnsConfig!.dnsTimeoutMs).toBe(5000);
  });

  it('边界 1 / 60000 → 保留', () => {
    const a = makeConfig(1);
    cm.validateConfig(a);
    expect(a.dnsConfig!.dnsTimeoutMs).toBe(1);
    const b = makeConfig(60000);
    cm.validateConfig(b);
    expect(b.dnsConfig!.dnsTimeoutMs).toBe(60000);
  });

  it('小数 → 四舍五入为整数', () => {
    const cfg = makeConfig(1499.6);
    cm.validateConfig(cfg);
    expect(cfg.dnsConfig!.dnsTimeoutMs).toBe(1500);
  });

  it.each([0, -100, 60001, NaN, Infinity, 'abc' as unknown as number])(
    '非法值 %p → 删除字段（回落核默认）',
    (bad) => {
      const cfg = makeConfig(bad);
      cm.validateConfig(cfg);
      expect(cfg.dnsConfig!.dnsTimeoutMs).toBeUndefined();
    }
  );

  it('未设 dnsTimeoutMs → 字段保持缺省、不报错', () => {
    const cfg = makeConfig(undefined);
    cm.validateConfig(cfg);
    expect(cfg.dnsConfig!.dnsTimeoutMs).toBeUndefined();
  });
});
