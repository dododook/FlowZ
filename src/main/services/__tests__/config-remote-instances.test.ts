/**
 * P5 Phase2 remoteInstances / activeInstanceId sanitize 单测（validateConfig）+ 远端 dashboard URL 推导。
 * 约定：缺/非法必填字段（id/name/host 非空字符串、port∈[1,65535] 整数）的实例整条丢弃；重复 id 去重；
 *   tls/secret/dashboardUrl 子字段按类型剔除非法值；activeInstanceId 非 'local' 且未命中任何实例 → 回落 undefined。
 *   一律不 throw（同 appRoutingEnabled/CIDR sanitize 标准，防单条脏值触发整配置回落致全丢）。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-remote-inst-'));

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
import type { UserConfig, RemoteInstance } from '../../../shared/types';
import { deriveRemoteDashboardUrl } from '../../ipc/handlers/remote-instance-handlers';

function makeConfig(over: Partial<UserConfig>): UserConfig {
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
    dnsConfig: { domesticDns: '', foreignDns: '', enableFakeIp: false },
    ...over,
  } as unknown as UserConfig;
}

describe('remoteInstances sanitize（P5 Phase2）', () => {
  let cm: ConfigManager;
  beforeEach(() => {
    cm = new ConfigManager(path.join(TMP, `ri-${Date.now()}-${Math.random()}.json`));
  });

  it('合法实例 → 保留全字段', () => {
    const cfg = makeConfig({
      remoteInstances: [
        {
          id: 'a',
          name: 'A',
          host: 'remote.example',
          port: 9090,
          secret: 's',
          tls: { skipVerify: true, ca: 'pem' },
          dashboardUrl: 'https://x/dashboard/',
        },
      ],
    });
    cm.validateConfig(cfg);
    expect(cfg.remoteInstances).toHaveLength(1);
    expect(cfg.remoteInstances![0]).toMatchObject({ id: 'a', name: 'A', port: 9090 });
  });

  it('非数组 → 重置为空数组', () => {
    const cfg = makeConfig({ remoteInstances: 'oops' as unknown as RemoteInstance[] });
    cm.validateConfig(cfg);
    expect(cfg.remoteInstances).toEqual([]);
  });

  it('缺必填 / 非法 port → 整条丢弃，合法的保留', () => {
    const cfg = makeConfig({
      remoteInstances: [
        { id: '', name: 'A', host: 'h', port: 1 }, // 空 id
        { id: 'b', name: '', host: 'h', port: 1 }, // 空 name
        { id: 'c', name: 'C', host: '', port: 1 }, // 空 host
        { id: 'd', name: 'D', host: 'h', port: 0 }, // 非法 port
        { id: 'e', name: 'E', host: 'h', port: 70000 }, // 越界 port
        { id: 'f', name: 'F', host: 'h', port: 9090 }, // 合法
      ] as RemoteInstance[],
    });
    cm.validateConfig(cfg);
    expect(cfg.remoteInstances!.map((i) => i.id)).toEqual(['f']);
  });

  it('重复 id → 去重保留首条', () => {
    const cfg = makeConfig({
      remoteInstances: [
        { id: 'a', name: 'first', host: 'h', port: 1 },
        { id: 'a', name: 'dup', host: 'h', port: 2 },
      ] as RemoteInstance[],
    });
    cm.validateConfig(cfg);
    expect(cfg.remoteInstances).toHaveLength(1);
    expect(cfg.remoteInstances![0].name).toBe('first');
  });

  it('非法 tls/secret/dashboardUrl 子字段 → 剔除该字段，不丢整条', () => {
    const cfg = makeConfig({
      remoteInstances: [
        {
          id: 'a',
          name: 'A',
          host: 'h',
          port: 1,
          secret: 123 as unknown as string,
          dashboardUrl: {} as unknown as string,
          tls: { skipVerify: 'yes' as unknown as boolean, ca: 5 as unknown as string },
        },
      ] as RemoteInstance[],
    });
    cm.validateConfig(cfg);
    const inst = cfg.remoteInstances![0] as unknown as Record<string, unknown>;
    expect(inst.secret).toBeUndefined();
    expect(inst.dashboardUrl).toBeUndefined();
    expect((inst.tls as Record<string, unknown>).skipVerify).toBeUndefined();
    expect((inst.tls as Record<string, unknown>).ca).toBeUndefined();
  });

  it('tls 非对象 → 删除整个 tls 字段', () => {
    const cfg = makeConfig({
      remoteInstances: [
        { id: 'a', name: 'A', host: 'h', port: 1, tls: 'on' as unknown as RemoteInstance['tls'] },
      ] as RemoteInstance[],
    });
    cm.validateConfig(cfg);
    expect(cfg.remoteInstances![0].tls).toBeUndefined();
  });

  // E-2：非环回主机 + 无 tls（h2c 明文）时剥离 secret，防 Bearer 明文上链路泄漏；环回 / 有 tls 放行。
  describe('E-2 非环回 h2c 明文 Bearer 防护', () => {
    it('非环回域名 + 无 tls + 有 secret → 剥 secret（实例保留）', () => {
      const cfg = makeConfig({
        remoteInstances: [
          { id: 'a', name: 'A', host: 'remote.example', port: 9090, secret: 'leak-me' },
        ] as RemoteInstance[],
      });
      cm.validateConfig(cfg);
      expect(cfg.remoteInstances).toHaveLength(1); // 不丢整条
      expect(cfg.remoteInstances![0].secret).toBeUndefined(); // secret 被剥
      expect(cfg.remoteInstances![0].host).toBe('remote.example'); // 其余字段保留
    });

    it('非环回 LAN IP + 无 tls + 有 secret → 剥 secret（LAN 视为非环回，仍泄漏）', () => {
      const cfg = makeConfig({
        remoteInstances: [
          { id: 'a', name: 'A', host: '192.168.1.50', port: 9090, secret: 'leak' },
        ] as RemoteInstance[],
      });
      cm.validateConfig(cfg);
      expect(cfg.remoteInstances![0].secret).toBeUndefined();
    });

    it('环回 localhost + 无 tls + 有 secret → 放行（SSH 隧道 / 本机 h2c 合法）', () => {
      const cfg = makeConfig({
        remoteInstances: [
          { id: 'a', name: 'A', host: 'localhost', port: 9090, secret: 'keep' },
        ] as RemoteInstance[],
      });
      cm.validateConfig(cfg);
      expect(cfg.remoteInstances![0].secret).toBe('keep');
    });

    it('环回 127.0.0.1 / ::1 + 无 tls + 有 secret → 放行', () => {
      const cfg = makeConfig({
        remoteInstances: [
          { id: 'a', name: 'A', host: '127.0.0.1', port: 9090, secret: 'k1' },
          { id: 'b', name: 'B', host: '::1', port: 9091, secret: 'k2' },
        ] as RemoteInstance[],
      });
      cm.validateConfig(cfg);
      expect(cfg.remoteInstances![0].secret).toBe('k1');
      expect(cfg.remoteInstances![1].secret).toBe('k2');
    });

    it('非环回 + 有 tls + 有 secret → 放行（TLS 下 Bearer 不明文）', () => {
      const cfg = makeConfig({
        remoteInstances: [
          { id: 'a', name: 'A', host: 'remote.example', port: 443, secret: 's', tls: {} },
        ] as RemoteInstance[],
      });
      cm.validateConfig(cfg);
      expect(cfg.remoteInstances![0].secret).toBe('s');
    });

    it('非环回 + 无 tls + 无 secret → 放行（无凭据可泄漏）', () => {
      const cfg = makeConfig({
        remoteInstances: [
          { id: 'a', name: 'A', host: 'remote.example', port: 9090 },
        ] as RemoteInstance[],
      });
      cm.validateConfig(cfg);
      expect(cfg.remoteInstances).toHaveLength(1);
      expect(cfg.remoteInstances![0].secret).toBeUndefined();
    });
  });
});

describe('activeInstanceId 收敛', () => {
  let cm: ConfigManager;
  beforeEach(() => {
    cm = new ConfigManager(path.join(TMP, `ai-${Date.now()}-${Math.random()}.json`));
  });

  it("'local' → 保留", () => {
    const cfg = makeConfig({ activeInstanceId: 'local' });
    cm.validateConfig(cfg);
    expect(cfg.activeInstanceId).toBe('local');
  });

  it('命中某实例 id → 保留', () => {
    const cfg = makeConfig({
      activeInstanceId: 'a',
      remoteInstances: [{ id: 'a', name: 'A', host: 'h', port: 1 }],
    });
    cm.validateConfig(cfg);
    expect(cfg.activeInstanceId).toBe('a');
  });

  it('未命中任何实例 → 删除（回落本地）', () => {
    const cfg = makeConfig({ activeInstanceId: 'ghost', remoteInstances: [] });
    cm.validateConfig(cfg);
    expect(cfg.activeInstanceId).toBeUndefined();
  });
});

describe('deriveRemoteDashboardUrl', () => {
  it('显式 dashboardUrl 优先', () => {
    expect(
      deriveRemoteDashboardUrl({
        id: 'a',
        name: 'A',
        host: 'h',
        port: 1,
        dashboardUrl: 'https://custom/x/',
      })
    ).toBe('https://custom/x/');
  });

  it('带 tls → https，无 tls → http；末尾 /dashboard/', () => {
    expect(
      deriveRemoteDashboardUrl({ id: 'a', name: 'A', host: 'remote.example', port: 9090, tls: {} })
    ).toBe('https://remote.example:9090/dashboard/');
    expect(deriveRemoteDashboardUrl({ id: 'a', name: 'A', host: 'h', port: 80 })).toBe(
      'http://h:80/dashboard/'
    );
  });
});
