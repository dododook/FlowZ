/**
 * LinuxSystemProxy 跨平台一致性单测（R6 High + Medium）。
 *
 * 关键：用真实 gsettings stdout 格式 mock（端口含 "uint32" 类型前缀），杜绝假绿——
 * R6-H1-1 实证：原 getProxyStatus 原样拼 "1.2.3.4:uint32 8080" → splitHostPort 恒 null → 恢复永不触发。
 * 覆盖 disableProxy + disableProxySync（含从 marker 读回 originalSettings 恢复，R6-H1-2）。
 */
jest.mock('child_process', () => ({
  exec: jest.fn(),
  execFile: jest.fn(),
  execSync: jest.fn(),
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

import { exec, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { LinuxSystemProxy, SystemProxyBase } from '../SystemProxyManager';

const execMock = exec as unknown as jest.Mock;
const execSyncMock = execSync as unknown as jest.Mock;

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

/** 记录 async exec 下发的 set 命令（get 命令返回空 stdout）。 */
function recordExecSet(): string[] {
  const cmds: string[] = [];
  execMock.mockImplementation(
    (cmd: string, cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
      if (/gsettings get/.test(cmd)) {
        cb(null, { stdout: '', stderr: '' });
        return;
      }
      cmds.push(cmd);
      cb(null, { stdout: '', stderr: '' });
    }
  );
  return cmds;
}

/** 记录 sync execSync 命令。 */
function recordExecSync(): string[] {
  const cmds: string[] = [];
  execSyncMock.mockImplementation((cmd: string) => {
    cmds.push(cmd);
    return '';
  });
  return cmds;
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

describe('LinuxSystemProxy 跨平台一致性（R6 High/Medium）', () => {
  beforeEach(() => {
    execMock.mockReset();
    execSyncMock.mockReset();
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

  describe('disableProxy（异步）— 从内存 originalSettings 恢复', () => {
    it('有有效快照 → 恢复 mode=manual + host/port + 清 marker', async () => {
      const proxy = new LinuxSystemProxy();
      // 模拟 enableProxy 已保存快照（经 getProxyStatus 剥前缀后的干净值）
      (proxy as unknown as { originalSettings: unknown }).originalSettings = {
        enabled: true,
        httpProxy: '1.2.3.4:8080',
      };
      const cmds = recordExecSet();

      await proxy.disableProxy();

      expect(cmds.some((c) => /mode "manual"/.test(c))).toBe(true);
      expect(cmds.some((c) => /host "1\.2\.3\.4"/.test(c))).toBe(true);
      expect(cmds.some((c) => /port 8080/.test(c))).toBe(true);
      expect(cmds.some((c) => /mode "none"/.test(c))).toBe(false);
      // marker 清理
      expect(fs.existsSync(MARKER_PATH)).toBe(false);
    });

    it('无快照 → 置 mode=none', async () => {
      const proxy = new LinuxSystemProxy();
      const cmds = recordExecSet();
      await proxy.disableProxy();
      expect(cmds.some((c) => /mode "none"/.test(c))).toBe(true);
      expect(cmds.some((c) => /mode "manual"/.test(c))).toBe(false);
    });

    it('M3 边界：缺端口 → 不进恢复，置 none', async () => {
      const proxy = new LinuxSystemProxy();
      (proxy as unknown as { originalSettings: unknown }).originalSettings = {
        enabled: true,
        httpProxy: '1.2.3.4',
      };
      const cmds = recordExecSet();
      await proxy.disableProxy();
      expect(cmds.some((c) => /mode "none"/.test(c))).toBe(true);
      expect(cmds.some((c) => /mode "manual"/.test(c))).toBe(false);
    });
  });

  describe('disableProxySync（同步，R6-H1-2）— 关机新建实例从 marker 读回恢复', () => {
    it('marker 含 originalSettings → 同步恢复（关机路径生效）', () => {
      // 模拟关机场景：新建实例（originalSettings=null），但 marker 有 enableProxy 持久化的快照
      writeMarkerWithSnapshot('127.0.0.1:7890', { enabled: true, httpProxy: '10.0.0.1:3128' });
      const proxy = new LinuxSystemProxy(); // 新实例，originalSettings=null
      const cmds = recordExecSync();

      proxy.disableProxySync();

      expect(cmds.some((c) => /mode "manual"/.test(c))).toBe(true);
      expect(cmds.some((c) => /host "10\.0\.0\.1"/.test(c))).toBe(true);
      expect(cmds.some((c) => /port 3128/.test(c))).toBe(true);
      expect(cmds.some((c) => /mode "none"/.test(c))).toBe(false);
      expect(fs.existsSync(MARKER_PATH)).toBe(false); // marker 清理
    });

    it('marker 无 originalSettings（用户原本无代理）→ 置 none', () => {
      writeMarkerWithSnapshot('127.0.0.1:7890', null); // enable 前 mode=none，无快照
      const proxy = new LinuxSystemProxy();
      const cmds = recordExecSync();
      proxy.disableProxySync();
      expect(cmds.some((c) => /mode "none"/.test(c))).toBe(true);
      expect(cmds.some((c) => /mode "manual"/.test(c))).toBe(false);
    });

    it('无 marker（正常状态）→ 置 none + clearMarker 无害', () => {
      const proxy = new LinuxSystemProxy();
      const cmds = recordExecSync();
      proxy.disableProxySync();
      expect(cmds.some((c) => /mode "none"/.test(c))).toBe(true);
    });
  });
});
