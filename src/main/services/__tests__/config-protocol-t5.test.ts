/**
 * T5 — protocol 白名单单测（ConfigManager.validateConfig 的 protocol 校验分支）。
 *
 * 收敛目标：server.protocol 的合法集合有且仅有一个真值来源 = src/shared/types.ts 的 Protocol 联合。
 *   ConfigManager 内 ALLOWED_PROTOCOLS 从 Protocol 派生（readonly Protocol[]），validateConfig 据此校验。
 *   新增协议只改 types.ts → 数组自动同步，消除「数组抄一遍 + 错误串再抄一遍」双重维护漂移。
 *
 * 覆盖：
 *  1. 每个 Protocol 成员（合法值）均被 validateConfig 放行（不抛 protocol 错误）。
 *     ——间接证明 ALLOWED_PROTOCOLS 与 Protocol 联合一一对齐（少一个就会让该协议的合法配置被拒）。
 *  2. 大小写不敏感：'VLESS' / 'VMESS' 同样放行（validateConfig 先 toLowerCase 再 includes）。
 *  3. 非法 protocol（不在白名单）被拒，错误信息枚举所有合法协议（助用户/开发定位）。
 *  4. protocol 缺省（undefined / 空串）被拒。
 *
 * 测试构造：validateConfig 是公开实例方法，不读盘（不走 loadConfig），故直接构造 ConfigManager
 *   后调 validateConfig(config)。electron 用同仓既有 fakeip-toggle.test 的 mock 模式。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-protocol-t5-'));

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
import type { Protocol, UserConfig } from '../../../shared/types';
import { ALL_PROTOCOLS } from '../../../shared/server-completeness';

// 攻击面/一致性 review H4：原此处自建 ALL_PROTOCOLS（11 项，漏 wireguard/tailscale/custom），
// 注释声称"与 types.ts 逐字对齐"实为假——白名单回归测试对漏列协议零覆盖。改 import 权威真值
//（server-completeness.ts 的 ALL_PROTOCOLS，14 项全），让"新增协议同步"的契约真正可验证。

/** 最小可校验 UserConfig（够过 validateConfig 的非 protocol 分支），按需覆盖 servers。
 *  mixed-only 后 validateConfig 尾部强制校验 mixedPort（http/socksPort 仅存在时宽松校验，且迁移会以 httpPort
 *  为种子补 mixedPort）+ logLevel；补齐这些，否则合法 protocol 测试会被无关字段误触发错误。 */
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

/** 构造仅含单个 server 的配置（protocol 可控），其余字段补齐各协议的必填项以免误触发其它分支。 */
function makeServerConfig(protocol: Protocol): UserConfig['servers'][number] {
  const base: any = {
    id: 'srv-1',
    name: 'test-server',
    protocol,
    address: '1.2.3.4',
    port: 443,
  };
  // 各协议必填字段（与 validateConfig 内分支一致），全填避免误触发「缺必填」错误
  base.uuid = '00000000-0000-0000-0000-000000000000';
  base.password = 'pass';
  base.username = 'user';
  base.shadowsocksSettings = { method: 'aes-256-gcm', password: 'pass' };
  // 一致性 review H4：补齐原漏列协议的必填（wireguard/custom）。原 makeServerConfig 未覆盖，
  // 导致 wireguard/custom 的「缺必填」校验从没被测到（测试本身漏列这俩协议）。
  if (protocol === 'wireguard') {
    base.wireguardSettings = {
      privateKey: 'priv-key',
      peerPublicKey: 'peer-key',
      localAddress: ['10.0.0.2/32'],
    };
  }
  if (protocol === 'custom') {
    base.customSettings = { outbound: { type: 'trojan', server: '1.2.3.4', server_port: 443 } };
  }
  return base;
}

describe('T5 protocol 白名单（validateConfig）', () => {
  let cm: ConfigManager;

  beforeEach(() => {
    const cfgPath = path.join(TMP, `protocol-t5-${Date.now()}-${Math.random()}.json`);
    cm = new ConfigManager(cfgPath);
  });

  it.each(ALL_PROTOCOLS)('合法 protocol=%s 被放行（不抛 protocol 错误）', (protocol) => {
    const cfg = makeConfig({ servers: [makeServerConfig(protocol)] });
    // 不抛即通过；其它字段已补齐，唯一变量是 protocol
    expect(() => cm.validateConfig(cfg)).not.toThrow();
  });

  it('大小写不敏感：VLESS / VMESS / Trojan 同样放行', () => {
    for (const p of ['VLESS', 'VMESS', 'Trojan', 'HYSTERIA2'] as unknown as Protocol[]) {
      const cfg = makeConfig({ servers: [makeServerConfig(p)] });
      expect(() => cm.validateConfig(cfg)).not.toThrow();
    }
  });

  it('非法 protocol（不在白名单）被拒，错误信息枚举全部合法协议', () => {
    const cfg = makeConfig({
      servers: [makeServerConfig('ssr' as unknown as Protocol)], // ssr 未在 Protocol 联合
    });
    expect(() => cm.validateConfig(cfg)).toThrow(/protocol/i);
    try {
      cm.validateConfig(cfg);
    } catch (e) {
      const msg = (e as Error).message;
      // 错误串必须枚举所有合法协议（曾出现数组含某协议、错误串漏列的漂移）
      for (const p of ALL_PROTOCOLS) {
        expect(msg).toContain(p);
      }
    }
  });

  it('protocol 缺省（undefined）被拒', () => {
    const srv = makeServerConfig('vless');
    delete (srv as any).protocol;
    const cfg = makeConfig({ servers: [srv] });
    expect(() => cm.validateConfig(cfg)).toThrow(/protocol/i);
  });

  it('protocol 空串被拒', () => {
    const cfg = makeConfig({ servers: [makeServerConfig('' as unknown as Protocol)] });
    expect(() => cm.validateConfig(cfg)).toThrow(/protocol/i);
  });
});
