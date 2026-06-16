/**
 * bypassLANExclude（绕过局域网排除段）的 validateConfig sanitize 单测。
 *
 * 不变量：脏数据一律 sanitize、绝不 throw —— validateConfig 在 loadConfig 路径 throw 会触发默认配置
 * 覆盖落盘致全量配置丢失，故非法/重复 CIDR 只丢弃不抛（与 customRules sanitize 同策略）。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-bypass-lan-'));

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
    socksPort: 1080,
    httpPort: 1087,
    logLevel: 'info',
    ...over,
  } as unknown as UserConfig;
}

describe('bypassLANExclude sanitize（validateConfig）', () => {
  let cm: ConfigManager;
  beforeEach(() => {
    cm = new ConfigManager(path.join(TMP, `bl-${Date.now()}-${Math.random()}.json`));
  });

  it('合法 CIDR 保留（v4/v6/含掩码）', () => {
    const cfg = makeConfig({ bypassLANExclude: ['10.10.10.0/24', '172.22.0.0/18', 'fd00::/8'] });
    expect(() => cm.validateConfig(cfg)).not.toThrow();
    expect(cfg.bypassLANExclude).toEqual(['10.10.10.0/24', '172.22.0.0/18', 'fd00::/8']);
  });

  it('非法 CIDR 丢弃、不 throw（防整配置回落默认）', () => {
    const cfg = makeConfig({
      bypassLANExclude: ['10.10.10.0/24', 'not-a-cidr', '10.10.10.0/999', 'garbage'],
    });
    expect(() => cm.validateConfig(cfg)).not.toThrow();
    expect(cfg.bypassLANExclude).toEqual(['10.10.10.0/24']);
  });

  it('trim 空白 + 去重 + 滤空串/非字符串', () => {
    const cfg = makeConfig({
      bypassLANExclude: [
        ' 10.10.10.0/24 ',
        '10.10.10.0/24',
        '',
        '   ',
        123 as unknown as string,
        null as unknown as string,
        '172.18.0.0/16',
      ],
    });
    expect(() => cm.validateConfig(cfg)).not.toThrow();
    expect(cfg.bypassLANExclude).toEqual(['10.10.10.0/24', '172.18.0.0/16']);
  });

  it('非数组 → 删除（重置默认）', () => {
    const cfg = makeConfig({ bypassLANExclude: 'oops' as unknown as string[] });
    expect(() => cm.validateConfig(cfg)).not.toThrow();
    expect(cfg.bypassLANExclude).toBeUndefined();
  });

  it('undefined → 原样（不强制注入）', () => {
    const cfg = makeConfig({});
    expect(() => cm.validateConfig(cfg)).not.toThrow();
    expect(cfg.bypassLANExclude).toBeUndefined();
  });
});
