/**
 * controlPort（clash_api 外部控制端口可配）单测。
 * 背景：9090 旧为硬编码"固定契约端口"，被另一 clash 系应用/任意进程占用时 clash_api 无法 bind → 死局。
 * 现 config.controlPort 可配（默认 9090），validateConfig 负责迁移补默认 + 防自撞本地端口 + 范围校验。
 *
 * 测试构造：validateConfig 是公开实例方法（既迁移又校验，且不读盘），直接构造 ConfigManager 后调用。
 * electron mock 同 config-protocol-t5.test.ts。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-control-port-'));

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
    logLevel: 'info',
    ...over,
  } as unknown as UserConfig;
}

describe('controlPort（clash_api 控制端口可配）', () => {
  let cm: ConfigManager;
  beforeEach(() => {
    cm = new ConfigManager(path.join(TMP, `cp-${Date.now()}-${Math.random()}.json`));
  });

  it('未设 → validateConfig 补默认 9090', () => {
    const cfg = makeConfig({ mixedPort: 7890 });
    cm.validateConfig(cfg);
    expect(cfg.controlPort).toBe(9090);
  });

  it('已设(>0) → 保留用户值（解冲突死局）', () => {
    const cfg = makeConfig({ mixedPort: 7890, controlPort: 9091 });
    cm.validateConfig(cfg);
    expect(cfg.controlPort).toBe(9091);
  });

  it('<=0 → 回退默认 9090', () => {
    const cfg = makeConfig({ mixedPort: 7890, controlPort: 0 });
    cm.validateConfig(cfg);
    expect(cfg.controlPort).toBe(9090);
  });

  it('防自撞：controlPort 与 mixedPort 同口 → 回退非冲突默认', () => {
    // mixedPort=9090 时不能再退 9090（仍撞）→ 取 9091
    const a = makeConfig({ mixedPort: 9090, controlPort: 9090 });
    cm.validateConfig(a);
    expect(a.controlPort).toBe(9091);
    expect(a.controlPort).not.toBe(a.mixedPort);
    // mixedPort 非 9090 时 → 回 9090
    const b = makeConfig({ mixedPort: 7890, controlPort: 7890 });
    cm.validateConfig(b);
    expect(b.controlPort).toBe(9090);
    expect(b.controlPort).not.toBe(b.mixedPort);
  });

  it('超范围 → 抛错', () => {
    expect(() => cm.validateConfig(makeConfig({ mixedPort: 7890, controlPort: 70000 }))).toThrow(
      /controlPort/
    );
  });
});
