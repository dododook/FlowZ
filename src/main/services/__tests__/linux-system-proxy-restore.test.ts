/**
 * LinuxSystemProxy 跨平台一致性单测（R6 High + Medium）+ 攻击面收口（Low-2）。
 *
 * 关键：用真实 gsettings stdout 格式 mock（端口含 "uint32" 类型前缀），杜绝假绿——
 * R6-H1-1 实证：原 getProxyStatus 原样拼 "1.2.3.4:uint32 8080" → splitHostPort 恒 null → 恢复永不触发。
 * 覆盖 disableProxy + disableProxySync（含从 marker 读回 originalSettings 恢复，R6-H1-2）。
 *
 * Low-2：restore/disableProxySync 的 gsettings 改 execFileAsync/execFileSync argv（host 来自系统
 * gsettings 可被 dconf 投毒），故本测试以 argv 数组断言，并验证恶意 host 作为字面参数下发、不经 shell 插值。
 * 注：getProxyStatus 的 gsettings GET 仍走 execAsync（只读、无注入面），保留 exec mock。
 */
jest.mock('child_process', () => ({
  exec: jest.fn(),
  execFile: jest.fn(),
  execSync: jest.fn(),
  execFileSync: jest.fn(),
}));

jest.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/flowz-test-restore',
    getName: () => 'FlowZ',
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => '/tmp/flowz-test-restore',
  },
  net: {},
}));

import { exec, execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { LinuxSystemProxy, SystemProxyBase } from '../SystemProxyManager';

const execMock = exec as unknown as jest.Mock;
const execFileMock = execFile as unknown as jest.Mock;
const execFileSyncMock = execFileSync as unknown as jest.Mock;

/** 模拟真实 gsettings get 输出（按命令返回对应 stdout）。端口带 GVariant uint32 前缀。 */
function mockGsettingsGet(handlers: Array<{ match: RegExp; stdout: string }>): void {
  execMock.mockImplementation(
    (cmd: string, cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
      for (const h of handlers) {
        if (h.match.test(cmd)) {
          cb(null, { stdout: h.stdout, stderr: '' });
          return;
        }
      }
      cb(null, { stdout: '', stderr: '' });
    }
  );
}

/** 记录 async execFile 下发的 gsettings set 调用（argv 扁平为 [file, ...args]）。 */
function recordExecFileSet(): string[][] {
  const calls: string[][] = [];
  execFileMock.mockImplementation((file: string, args: string[], a3: unknown, a4?: unknown) => {
    const cb = (typeof a3 === 'function' ? a3 : a4) as (
      e: null,
      r: { stdout: string; stderr: string }
    ) => void;
    calls.push([file, ...args]);
    cb(null, { stdout: '', stderr: '' });
  });
  return calls;
}

/** 记录 sync execFileSync 下发的 gsettings 调用（argv 扁平为 [file, ...args]）。 */
function recordExecFileSync(): string[][] {
  const calls: string[][] = [];
  execFileSyncMock.mockImplementation((file: string, args: string[]) => {
    calls.push([file, ...args]);
    return '';
  });
  return calls;
}

/** argv 调用集合里是否存在「同时含全部给定 token」的一条。 */
function hasCall(calls: string[][], ...tokens: string[]): boolean {
  return calls.some((c) => tokens.every((t) => c.includes(t)));
}

const MARKER_PATH = (SystemProxyBase as unknown as { getMarkerPath: () => string }).getMarkerPath();

/** 写一个带 originalSettings 的 marker（模拟 enableProxy 持久化后、关机新建实例前的状态）。 */
function writeMarkerWithSnapshot(ourHostPort: string, originalSettings: unknown): void {
  fs.mkdirSync(path.dirname(MARKER_PATH), { recursive: true });
  fs.writeFileSync(
    MARKER_PATH,
    JSON.stringify({
      ourHostPort,
      at: Date.now(),
      ...(originalSettings ? { originalSettings } : {}),
    })
  );
}

function clearMarkerFile(): void {
  try {
    fs.rmSync(MARKER_PATH, { force: true });
  } catch {
    /* ignore */
  }
}

describe('LinuxSystemProxy 跨平台一致性（R6 High/Medium）+ 注入收口（Low-2）', () => {
  beforeEach(() => {
    execMock.mockReset();
    execFileMock.mockReset();
    execFileSyncMock.mockReset();
    clearMarkerFile();
  });
  afterEach(() => {
    clearMarkerFile();
  });

  describe('getProxyStatus 端口解析（R6-H1-1）', () => {
    it('剥 gsettings uint32 类型前缀，httpProxy 为干净的 host:port', async () => {
      const proxy = new LinuxSystemProxy();
      mockGsettingsGet([
        { match: /mode$/, stdout: "'manual'\n" },
        { match: /http host$/, stdout: "'1.2.3.4'\n" },
        { match: /http port$/, stdout: 'uint32 8080\n' }, // 真实 GVariant 格式
      ]);
      const status = await proxy.getProxyStatus();
      expect(status).toEqual({ enabled: true, httpProxy: '1.2.3.4:8080' }); // 干净，无 uint32
    });
  });

  describe('disableProxy（异步）— 从内存 originalSettings 恢复（execFileAsync argv）', () => {
    it('有有效快照 → 恢复 mode=manual + host/port + 清 marker', async () => {
      const proxy = new LinuxSystemProxy();
      (proxy as unknown as { originalSettings: unknown }).originalSettings = {
        enabled: true,
        httpProxy: '1.2.3.4:8080',
      };
      const calls = recordExecFileSet();

      await proxy.disableProxy();

      expect(hasCall(calls, 'mode', 'manual')).toBe(true);
      expect(hasCall(calls, 'org.gnome.system.proxy.http', 'host', '1.2.3.4')).toBe(true);
      expect(hasCall(calls, 'org.gnome.system.proxy.http', 'port', '8080')).toBe(true);
      // capture-three（#2）：原快照仅 http → 不把 http 值扇出到未设的 https/socks（防假 socks）
      expect(hasCall(calls, 'org.gnome.system.proxy.https', 'host', '1.2.3.4')).toBe(false);
      expect(hasCall(calls, 'org.gnome.system.proxy.socks', 'host', '1.2.3.4')).toBe(false);
      // Low-1 收口：原本未设的 https/socks 被显式清空（host=''），撤销 enable 期写入的 FlowZ 死端口残留
      expect(hasCall(calls, 'org.gnome.system.proxy.https', 'host', '')).toBe(true);
      expect(hasCall(calls, 'org.gnome.system.proxy.socks', 'host', '')).toBe(true);
      expect(hasCall(calls, 'mode', 'none')).toBe(false);
      expect(fs.existsSync(MARKER_PATH)).toBe(false);
    });

    it('无快照 → 置 mode=none', async () => {
      const proxy = new LinuxSystemProxy();
      const calls = recordExecFileSet();
      await proxy.disableProxy();
      expect(hasCall(calls, 'mode', 'none')).toBe(true);
      expect(hasCall(calls, 'mode', 'manual')).toBe(false);
    });

    it('M3 边界：缺端口 → 不进恢复，置 none', async () => {
      const proxy = new LinuxSystemProxy();
      (proxy as unknown as { originalSettings: unknown }).originalSettings = {
        enabled: true,
        httpProxy: '1.2.3.4',
      };
      const calls = recordExecFileSet();
      await proxy.disableProxy();
      expect(hasCall(calls, 'mode', 'none')).toBe(true);
      expect(hasCall(calls, 'mode', 'manual')).toBe(false);
    });

    it('Low-2：恶意 host 作为字面 argv 参数下发，不经 shell 插值', async () => {
      const proxy = new LinuxSystemProxy();
      const evil = '$(touch /tmp/pwned)';
      (proxy as unknown as { originalSettings: unknown }).originalSettings = {
        enabled: true,
        httpProxy: `${evil}:8080`,
      };
      const calls = recordExecFileSet();
      await proxy.disableProxy();
      // 恶意串作为独立 host 参数原样出现在 argv（execFile 不过 shell → 无命令替换执行）
      expect(hasCall(calls, 'org.gnome.system.proxy.http', 'host', evil)).toBe(true);
      // 每条调用都是 file='gsettings' + argv，绝无把 host 拼进单一命令串
      expect(calls.every((c) => c[0] === 'gsettings')).toBe(true);
      // 负向护栏：完全不走 exec（字符串 /bin/sh -c）路径——恶意串绝无机会被 shell 解释
      expect(execMock).not.toHaveBeenCalled();
    });

    it('#2：三 schema 各有快照 → 各自恢复（不丢、不串值）', async () => {
      const proxy = new LinuxSystemProxy();
      (proxy as unknown as { originalSettings: unknown }).originalSettings = {
        enabled: true,
        httpProxy: '1.1.1.1:80',
        httpsProxy: '2.2.2.2:443',
        socksProxy: '3.3.3.3:1080',
      };
      const calls = recordExecFileSet();
      await proxy.disableProxy();
      expect(hasCall(calls, 'org.gnome.system.proxy.http', 'host', '1.1.1.1')).toBe(true);
      expect(hasCall(calls, 'org.gnome.system.proxy.http', 'port', '80')).toBe(true);
      expect(hasCall(calls, 'org.gnome.system.proxy.https', 'host', '2.2.2.2')).toBe(true);
      expect(hasCall(calls, 'org.gnome.system.proxy.https', 'port', '443')).toBe(true);
      expect(hasCall(calls, 'org.gnome.system.proxy.socks', 'host', '3.3.3.3')).toBe(true);
      expect(hasCall(calls, 'org.gnome.system.proxy.socks', 'port', '1080')).toBe(true);
    });

    it('#4：裸 IPv6 host 正确拆分恢复（::1:8080 → host=::1, port=8080）', async () => {
      const proxy = new LinuxSystemProxy();
      (proxy as unknown as { originalSettings: unknown }).originalSettings = {
        enabled: true,
        httpProxy: '::1:8080',
      };
      const calls = recordExecFileSet();
      await proxy.disableProxy();
      expect(hasCall(calls, 'org.gnome.system.proxy.http', 'host', '::1')).toBe(true);
      expect(hasCall(calls, 'org.gnome.system.proxy.http', 'port', '8080')).toBe(true);
    });
  });

  describe('disableProxySync（同步，R6-H1-2）— 关机新建实例从 marker 读回恢复（execFileSync argv）', () => {
    it('marker 含 originalSettings → 同步恢复（关机路径生效）', () => {
      writeMarkerWithSnapshot('127.0.0.1:7890', { enabled: true, httpProxy: '10.0.0.1:3128' });
      const proxy = new LinuxSystemProxy();
      const calls = recordExecFileSync();

      proxy.disableProxySync();

      expect(hasCall(calls, 'mode', 'manual')).toBe(true);
      expect(hasCall(calls, 'org.gnome.system.proxy.http', 'host', '10.0.0.1')).toBe(true);
      expect(hasCall(calls, 'org.gnome.system.proxy.http', 'port', '3128')).toBe(true);
      expect(hasCall(calls, 'mode', 'none')).toBe(false);
      expect(fs.existsSync(MARKER_PATH)).toBe(false);
    });

    it('marker 无 originalSettings（用户原本无代理）→ 置 none', () => {
      writeMarkerWithSnapshot('127.0.0.1:7890', null);
      const proxy = new LinuxSystemProxy();
      const calls = recordExecFileSync();
      proxy.disableProxySync();
      expect(hasCall(calls, 'mode', 'none')).toBe(true);
      expect(hasCall(calls, 'mode', 'manual')).toBe(false);
    });

    it('无 marker（正常状态）→ 置 none', () => {
      const proxy = new LinuxSystemProxy();
      const calls = recordExecFileSync();
      proxy.disableProxySync();
      expect(hasCall(calls, 'mode', 'none')).toBe(true);
    });

    it('Nit-1：关机 gsettings 全失败 → 保留 marker（不丢回滚信号）', () => {
      writeMarkerWithSnapshot('127.0.0.1:7890', { enabled: true, httpProxy: '10.0.0.1:3128' });
      // 关机时 gsettings/DBus 不可用：所有 execFileSync 抛错 → gsettingsOk 恒 false
      execFileSyncMock.mockImplementation(() => {
        throw new Error('gsettings unavailable at shutdown');
      });
      const proxy = new LinuxSystemProxy();
      proxy.disableProxySync();
      // 全部 gset 失败 → 不清 marker，保留（含持久化 originalSettings）供下次启动重试恢复
      expect(fs.existsSync(MARKER_PATH)).toBe(true);
    });
  });
});
