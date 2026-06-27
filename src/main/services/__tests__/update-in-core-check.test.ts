/**
 * update-in 配置真核 check 集成（Phase 2）：`generateSingBoxConfig` 生成含 update-in 的配置 → 起真 sing-box 核
 * `check` → 断言不 FATAL，证「Phase 2 含 update-in 的配置在真核里合法可启动」（config-snapshot 只验生成字节、
 * 验不到核接受性）。验证范围=配置合法性；TUN 实际接管 / DNS 死角 / DPI / 三平台仍需真机（本机不验系统网络）。
 *
 * 需 Linux 核：env `FLOWZ_TEST_SINGBOX` 指向核二进制；未设/不存在则整组 skip（CI 友好，不阻塞）。
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('electron', () => ({
  app: {
    getPath: () => '/fake/userData',
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => '/fake/app',
  },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ProxyManager } from '../ProxyManager';
import type { UserConfig, ServerConfig } from '../../../shared/types';

const CORE = process.env.FLOWZ_TEST_SINGBOX;
const haveCore = !!CORE && fs.existsSync(CORE);
const d = haveCore ? describe : describe.skip;

function makeSvc(): any {
  const svc: any = new ProxyManager(undefined, undefined, '/fake/cfg.json', '/fake/sing-box');
  svc.coreVersion = '1.14.0';
  return svc;
}

function server(over: Partial<ServerConfig>): ServerConfig {
  return {
    id: 's1',
    name: 'HK',
    protocol: 'vless',
    address: 'a.example.com',
    port: 443,
    uuid: 'uuid-1',
    ...over,
  } as ServerConfig;
}

function cfg(over: Partial<UserConfig>): UserConfig {
  return {
    subscriptions: [],
    servers: [server({})],
    selectedServerId: 's1',
    proxyMode: 'smart',
    proxyModeType: 'systemProxy',
    tunConfig: { mtu: 1350, stack: 'system', autoRoute: true, strictRoute: true },
    customRules: [],
    appRules: [],
    customAppPresets: [],
    autoStart: false,
    silentStart: false,
    autoConnect: false,
    minimizeToTray: false,
    socksPort: 1080,
    httpPort: 1087,
    mixedPort: 7890,
    logLevel: 'info',
    clashApiSecret: 'testsecret',
    ...over,
  } as unknown as UserConfig;
}

d('update-in 配置真核 check（需 env FLOWZ_TEST_SINGBOX）', () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-updatein-check-'));
  });
  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function checkConfig(config: unknown): { ok: boolean; out: string } {
    const p = path.join(tmpDir, `cfg-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify(config, null, 2));
    try {
      const out = execFileSync(CORE as string, ['check', '-c', p], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, out };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}` };
    }
  }

  for (const proxyMode of ['global', 'smart', 'direct'] as const) {
    it(`${proxyMode}：含 update-in 的生成配置过真核 check（不 FATAL）`, () => {
      const svc = makeSvc();
      svc.updateInPort = 21003;
      const config = svc.generateSingBoxConfig(cfg({ proxyMode }));
      // sanity：update-in socks inbound 确实生成
      expect(
        (config.inbounds as Array<{ tag: string; type: string }>).some(
          (i) => i.tag === 'update-in' && i.type === 'socks'
        )
      ).toBe(true);
      const r = checkConfig(config);
      if (!r.ok) throw new Error(`sing-box check 失败（${proxyMode}）：\n${r.out}`);
      expect(r.ok).toBe(true);
    });
  }
});
