/**
 * buildLogConfig 单测 —— 原 ProxyManager.generateLogConfig 无单测（仅 config-snapshot 集成锁字节）。
 * 锁：日志级别（含隐私抬级）/ disableLogFile / TUN(mac·win·linux) output 文件路径分支（按平台）。
 */
jest.mock('electron', () => ({
  app: { getPath: () => '/fake/userData', getAppPath: () => '/fake/app', isPackaged: false },
  net: {},
}));

import { buildLogConfig } from '../singbox-log-builder';
import type { UserConfig } from '../../../shared/types';
import { withPlatform } from './platform-test-utils';

const cfg = (over: Partial<UserConfig>): UserConfig => over as unknown as UserConfig;

describe('buildLogConfig', () => {
  it('默认 info + timestamp；privacyMode=true → 抬到 ≥warn', () => {
    expect(buildLogConfig(cfg({}), false)).toMatchObject({ level: 'info', timestamp: true });
    const priv = buildLogConfig(cfg({ logLevel: 'info' }), true);
    expect(['warn', 'error', 'fatal']).toContain(priv.level); // 隐私从源头不记连接明细
  });

  it('disableLogFile → disabled:true，提前返回（无 output）', () => {
    const c = withPlatform('darwin', () =>
      buildLogConfig(cfg({ proxyModeType: 'tun', disableLogFile: true }), false)
    );
    expect(c.disabled).toBe(true);
    expect(c.output).toBeUndefined();
  });

  it('systemProxy（任意平台）→ 不写 output（stdout 可捕获）', () => {
    const c = withPlatform('darwin', () =>
      buildLogConfig(cfg({ proxyModeType: 'systemProxy' }), false)
    );
    expect(c.output).toBeUndefined();
  });

  it('TUN + macOS/Windows → 写 output 文件路径（提权运行时无法捕获 stdout）', () => {
    const mac = withPlatform('darwin', () => buildLogConfig(cfg({ proxyModeType: 'tun' }), false));
    expect(mac.output).toMatch(/\.log$/);
    const win = withPlatform('win32', () => buildLogConfig(cfg({ proxyModeType: 'tun' }), false));
    expect(win.output).toMatch(/\.log$/);
  });

  it('TUN + Linux → 写 output 文件路径（issue #210：消除平台不对称，三平台 TUN 统一写文件 + 截断）', () => {
    const c = withPlatform('linux', () => buildLogConfig(cfg({ proxyModeType: 'tun' }), false));
    expect(c.output).toMatch(/\.log$/);
  });

  it('systemProxy + Linux → 不写 output（日志量小，stdout 直喂可接受，不起 logFileWatcher）', () => {
    // 确认 P1 只影响 Linux TUN：Linux 系统代理模式仍走 stdout（非 TUN，日志量小，无 pendingWrites 风险）。
    const c = withPlatform('linux', () =>
      buildLogConfig(cfg({ proxyModeType: 'systemProxy' }), false)
    );
    expect(c.output).toBeUndefined();
  });

  it('manual 模式（任意平台）→ 不写 output（直接子进程、非 TUN，stdout 可捕获；与运行时 logFileWatcher 谓词一致）', () => {
    // H1 回归防护：manual 是非系统代理模式但非 TUN 接管，构建器不得误把它当 TUN 设 output（否则 sing-box 写文件
    // 而 ProxyManager 不起 watcher → 日志静默丢失）。与 needsRootPrivilege/isTunModeNow 同谓词（严格 === 'tun'）。
    for (const plat of ['linux', 'darwin', 'win32'] as const) {
      const c = withPlatform(plat, () => buildLogConfig(cfg({ proxyModeType: 'manual' }), false));
      expect(c.output).toBeUndefined();
    }
  });
});
