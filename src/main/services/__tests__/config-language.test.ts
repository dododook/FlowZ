/**
 * config.language 单一真值源 sanitize + 默认值单测（validateConfig / getDefaultConfig）。
 * 约定：language 是界面语言「选择」（'auto'|具体码）的真值源，主进程直接据此定托盘/通知语言。
 *   非 string 一律删除（sanitize 不 throw，同纯开关字段标准）→ 缺省视为系统解析；新装默认 'auto'。
 *
 * 测试构造同 config-dns-timeout.test.ts：validateConfig 公开实例方法、不读盘，直接构造 ConfigManager 调用。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-config-lang-'));

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

function makeConfig(language: unknown): UserConfig {
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
    language,
  } as unknown as UserConfig;
}

describe('config.language sanitize + default', () => {
  let cm: ConfigManager;
  beforeEach(() => {
    cm = new ConfigManager(path.join(TMP, `lang-${Date.now()}-${Math.random()}.json`));
  });

  it("'auto' → 保留（跟随系统的选择）", () => {
    const cfg = makeConfig('auto');
    cm.validateConfig(cfg);
    expect(cfg.language).toBe('auto');
  });

  it("具体语言码 'zh-CN' → 保留", () => {
    const cfg = makeConfig('zh-CN');
    cm.validateConfig(cfg);
    expect(cfg.language).toBe('zh-CN');
  });

  it('未设（存量配置缺该键）→ 保持 undefined、不报错（由渲染端从 localStorage 迁移回填）', () => {
    const cfg = makeConfig(undefined);
    cm.validateConfig(cfg);
    expect(cfg.language).toBeUndefined();
  });

  it.each([123, true, {}, [], null])('非 string 值 %p → 删除（sanitize 不 throw）', (bad) => {
    const cfg = makeConfig(bad);
    expect(() => cm.validateConfig(cfg)).not.toThrow();
    expect(cfg.language).toBeUndefined();
  });

  it("空串 '' → 删除（防渲染端迁移守卫 !language 永不收敛的无限回填）", () => {
    const cfg = makeConfig('');
    cm.validateConfig(cfg);
    expect(cfg.language).toBeUndefined();
  });

  it('新装默认配置 language = auto', () => {
    const def = (cm as unknown as { createDefaultConfig: () => UserConfig }).createDefaultConfig();
    expect(def.language).toBe('auto');
  });
});
