/**
 * remoteInstances / activeInstanceId 死字段清除单测（validateConfig，item 2 / B 隐私回归）。
 *
 * 背景：远程实例 feature 已移除（UserConfig 类型已删这两个字段）。旧版升级用户的 config.json 可能仍残留
 *   remoteInstances[].secret（明文 Bearer）。CONFIG_GET 的内联回退 `{...cfg}` 不再剥它 → 既留盘 config.json
 *   又随响应下发渲染端，破坏「远程 secret 明文永不出主进程」不变量。
 * 修：validateConfig（loadConfig 与 saveConfig 两路径都过）彻底 delete 这俩死字段——既清盘（下次落盘不再写）
 *   又不下发。删除而非脱敏：feature 不存在。
 *
 * 测试构造：validateConfig 公开实例方法、不读盘，直接构造 ConfigManager 调用（同 config-dns-timeout.test.ts）。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-remote-scrub-'));

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

/** 基础合法 config + 任意附加（残留）字段。 */
function makeConfig(extra: Record<string, unknown>): UserConfig {
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
    ...extra,
  } as unknown as UserConfig;
}

describe('remoteInstances / activeInstanceId 死字段清除（item 2）', () => {
  let cm: ConfigManager;
  beforeEach(() => {
    cm = new ConfigManager(path.join(TMP, `ri-${Date.now()}-${Math.random()}.json`));
  });

  it('残留 remoteInstances（含明文 secret）→ 整字段被删除', () => {
    const cfg = makeConfig({
      remoteInstances: [
        { id: 'r1', name: 'remote-1', host: '1.2.3.4', port: 9090, secret: 'plaintext-bearer-aaa' },
      ],
    });
    cm.validateConfig(cfg);
    expect((cfg as unknown as Record<string, unknown>).remoteInstances).toBeUndefined();
    // secret 不残留在 config 任意层（序列化后不含明文）。
    expect(JSON.stringify(cfg)).not.toContain('plaintext-bearer-aaa');
  });

  it('残留 activeInstanceId → 被删除', () => {
    const cfg = makeConfig({ activeInstanceId: 'r1' });
    cm.validateConfig(cfg);
    expect((cfg as unknown as Record<string, unknown>).activeInstanceId).toBeUndefined();
  });

  it('两字段同时残留 → 都被删除，其余配置不受影响', () => {
    const cfg = makeConfig({
      remoteInstances: [{ id: 'r1', secret: 's' }],
      activeInstanceId: 'r1',
    });
    cm.validateConfig(cfg);
    expect((cfg as unknown as Record<string, unknown>).remoteInstances).toBeUndefined();
    expect((cfg as unknown as Record<string, unknown>).activeInstanceId).toBeUndefined();
    // 正常字段保留（不连累整配置）。
    expect(cfg.mixedPort).toBe(7890);
    expect(cfg.proxyMode).toBe('smart');
  });

  it('无残留字段 → validateConfig 正常通过、不报错', () => {
    const cfg = makeConfig({});
    expect(() => cm.validateConfig(cfg)).not.toThrow();
    expect((cfg as unknown as Record<string, unknown>).remoteInstances).toBeUndefined();
    expect((cfg as unknown as Record<string, unknown>).activeInstanceId).toBeUndefined();
  });
});
