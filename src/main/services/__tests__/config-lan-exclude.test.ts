/**
 * tunConfig.inboundExcludeCidrs sanitize 单测（validateConfig）。
 * 约定：经 normalizeTunExcludeCidr 规范化（裸 IP 补 /32|/128、拒 catch-all/过宽、严格校验 sing-box netip 口径）
 *   + trim + 去重；范围/形状非法/catch-all/过宽/域名/空/非字符串 静默剔除并告警（dropped 只计真·非法，不含去重）；
 *   **非数组 / 空 / 全非法 → 删字段**（回落 undefined「无排除」，避免 [] 触发 configGenerationNorm 翻转/无谓重启）。
 *   一律不 throw（防单条脏值触发整配置回落默认）。
 * 测试构造：validateConfig 公开实例方法、不读盘，直接构造 ConfigManager（同 config-dns-timeout.test.ts）。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-lan-exclude-'));

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

function makeConfig(inboundExcludeCidrs: unknown): UserConfig {
  return {
    subscriptions: [],
    servers: [],
    selectedServerId: null,
    proxyMode: 'smart',
    proxyModeType: 'tun',
    mixedPort: 7890,
    tunConfig: {
      mtu: 1350,
      stack: 'system',
      autoRoute: true,
      strictRoute: true,
      inboundExcludeCidrs,
    },
    customRules: [],
    autoStart: false,
    silentStart: false,
    autoConnect: false,
    minimizeToTray: false,
    logLevel: 'info',
    dnsConfig: { domesticDns: '', foreignDns: '', enableFakeIp: false },
  } as unknown as UserConfig;
}

describe('tunConfig.inboundExcludeCidrs sanitize', () => {
  let cm: ConfigManager;
  beforeEach(() => {
    cm = new ConfigManager(path.join(TMP, `le-${Date.now()}-${Math.random()}.json`));
  });

  it('合法 v4/v6 CIDR → 保留 + trim', () => {
    const cfg = makeConfig(['  10.147.0.0/16  ', '192.168.50.0/24', 'fd00::/8']);
    cm.validateConfig(cfg);
    expect(cfg.tunConfig.inboundExcludeCidrs).toEqual([
      '10.147.0.0/16',
      '192.168.50.0/24',
      'fd00::/8',
    ]);
  });

  it('去重', () => {
    const cfg = makeConfig(['10.147.0.0/16', '10.147.0.0/16', ' 10.147.0.0/16 ']);
    cm.validateConfig(cfg);
    expect(cfg.tunConfig.inboundExcludeCidrs).toEqual(['10.147.0.0/16']);
  });

  it('范围非法（八位组>255 / 前缀越界）→ 剔除', () => {
    const cfg = makeConfig(['10.147.0.0/16', '256.1.1.1/8', '10.0.0.0/40']);
    cm.validateConfig(cfg);
    expect(cfg.tunConfig.inboundExcludeCidrs).toEqual(['10.147.0.0/16']);
  });

  it('形状非法 / 域名 / 空 / 非字符串 → 剔除', () => {
    const cfg = makeConfig(['10.147.0.0/16', 'not-a-cidr', 'example.com', '', 123, null, {}]);
    cm.validateConfig(cfg);
    expect(cfg.tunConfig.inboundExcludeCidrs).toEqual(['10.147.0.0/16']);
  });

  it('裸 IP → 规范化补掩码（/32、/128）', () => {
    const cfg = makeConfig(['192.168.1.50', '2001:db8::1']);
    cm.validateConfig(cfg);
    expect(cfg.tunConfig.inboundExcludeCidrs).toEqual(['192.168.1.50/32', '2001:db8::1/128']);
  });

  it('catch-all / 过宽段 → 剔除（防排空 TUN）', () => {
    const cfg = makeConfig(['10.147.0.0/16', '0.0.0.0/0', '::/0', '0.0.0.0/1', '10.0.0.0/7']);
    cm.validateConfig(cfg);
    expect(cfg.tunConfig.inboundExcludeCidrs).toEqual(['10.147.0.0/16']);
  });

  it('非数组 → 删字段（回落"无排除"）', () => {
    const cfg = makeConfig('10.147.0.0/16');
    cm.validateConfig(cfg);
    expect(cfg.tunConfig.inboundExcludeCidrs).toBeUndefined();
  });

  it('空数组 → 删字段（回落 undefined，避免 [] 触发 configGenerationNorm 翻转/无谓重启）', () => {
    const cfg = makeConfig([]);
    cm.validateConfig(cfg);
    expect(cfg.tunConfig.inboundExcludeCidrs).toBeUndefined();
  });

  it('全非法 → 删字段（清空后回落 undefined）', () => {
    const cfg = makeConfig(['not-a-cidr', '0.0.0.0/0']);
    cm.validateConfig(cfg);
    expect(cfg.tunConfig.inboundExcludeCidrs).toBeUndefined();
  });

  it('undefined → 保持缺省、不报错', () => {
    const cfg = makeConfig(undefined);
    cm.validateConfig(cfg);
    expect(cfg.tunConfig.inboundExcludeCidrs).toBeUndefined();
  });
});
