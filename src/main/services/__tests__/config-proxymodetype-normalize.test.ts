/**
 * proxyModeType 归一化回归（validateConfig）。
 *
 * 铁律：必须归一到**权威 camelCase 规范值** 'systemProxy'（ProxyModeType 联合类型与 ProxyManager
 * 的 === 'systemProxy' 谓词均为 camelCase）。曾因盲 toLowerCase 把 'systemProxy' 回写成 'systemproxy'，
 * 使 ProxyManager.ts 的 === 'systemProxy' 恒 false、系统代理分支永不命中 → 系统代理从不设置、流量直连泄漏。
 *
 * 构造同 config-dns-timeout.test.ts：validateConfig 公开实例方法、不读盘，直接构造 ConfigManager 调用。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-modetype-'));

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

function makeConfig(proxyModeType: unknown): UserConfig {
  return {
    subscriptions: [],
    servers: [],
    selectedServerId: null,
    proxyMode: 'smart',
    proxyModeType,
    mixedPort: 7890,
    tunConfig: { mtu: 1350, stack: 'system', autoRoute: true, strictRoute: true },
    customRules: [],
    autoStart: false,
    silentStart: false,
    autoConnect: false,
    minimizeToTray: false,
    logLevel: 'info',
    dnsConfig: { domesticDns: '', foreignDns: '', enableFakeIp: false },
  } as unknown as UserConfig;
}

describe('proxyModeType 归一化（validateConfig → 权威 camelCase）', () => {
  let cm: ConfigManager;
  beforeEach(() => {
    cm = new ConfigManager(path.join(TMP, `mt-${Date.now()}-${Math.random()}.json`));
  });

  it.each(['systemProxy', 'systemproxy', 'SYSTEMPROXY', 'SystemProxy'])(
    'systemProxy 任意大小写 (%s) → 规范 camelCase "systemProxy"（不得变 systemproxy）',
    (input) => {
      const cfg = makeConfig(input);
      cm.validateConfig(cfg);
      expect(cfg.proxyModeType).toBe('systemProxy');
    }
  );

  it.each(['tun', 'TUN', 'Tun'])('tun 任意大小写 (%s) → "tun"', (input) => {
    const cfg = makeConfig(input);
    cm.validateConfig(cfg);
    expect(cfg.proxyModeType).toBe('tun');
  });

  it.each(['manual', 'MANUAL'])('manual 任意大小写 (%s) → "manual"', (input) => {
    const cfg = makeConfig(input);
    cm.validateConfig(cfg);
    expect(cfg.proxyModeType).toBe('manual');
  });

  it('非法值 → throw', () => {
    expect(() => cm.validateConfig(makeConfig('bogus'))).toThrow(/proxyModeType/);
  });
});
