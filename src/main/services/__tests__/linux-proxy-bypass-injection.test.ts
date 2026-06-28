/**
 * Linux 系统代理 bypass 命令注入防护单测（攻击面 review H1）。
 *
 * H1：bypass 列表（用户可控：设置 UI 编辑 / 备份导入注入）原用 execAsync shell 双引号拼接
 * → 双引号内 $()/反引号仍展开 → 命令注入。修复：ignore-hosts 改用 execFileAsync 数组参数，
 * ignoreList 作为独立 argv 元素，不经 /bin/sh -c 解析，从根本上消除注入面。
 * 本测试与 mac H3 测试对称（R3 review Low-1：补 H1 行为级测试）。
 */
jest.mock('child_process', () => ({
  exec: jest.fn(),
  execFile: jest.fn(),
  execSync: jest.fn(),
}));

jest.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/flowz-test-linux-inj',
    getName: () => 'FlowZ',
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => '/tmp/flowz-test-linux-inj',
  },
  net: {},
}));

import { exec, execFile } from 'child_process';
import { LinuxSystemProxy } from '../SystemProxyManager';

const execMock = exec as unknown as jest.Mock;
const execFileMock = execFile as unknown as jest.Mock;

describe('攻击面 H1：Linux ignore-hosts 用 execFile 参数数组（防命令注入）', () => {
  beforeEach(() => {
    execMock.mockReset();
    execFileMock.mockReset();
    // getProxyStatus（enableProxy 保存原始设置时调）+ 各 gsettings get 用 exec 返回空
    execMock.mockImplementation(
      (_cmd: string, cb: (e: null, r: { stdout: string; stderr: string }) => void) =>
        cb(null, { stdout: '', stderr: '' })
    );
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (e: null) => void) =>
      cb(null)
    );
  });

  it('含 shell 元字符的 bypass 项经 execFile argv 传递（不经 shell 解析）', async () => {
    const proxy = new LinuxSystemProxy();
    await proxy.enableProxy('127.0.0.1', 7890, 7891, [
      'normal.com',
      'evil$(touch /tmp/pwned)', // $() 注入向量
      '`id`', // 反引号注入向量
      'a;rm -rf ~', // ; 命令分隔
    ]);

    // ignore-hosts 必须走 execFile（参数数组），不能走 exec（shell 字符串）
    const calls = execFileMock.mock.calls as unknown as Array<[string, string[], ...unknown[]]>;
    const ignoreCall = calls.find((c) => c[1]?.[0] === 'set' && c[1]?.[2] === 'ignore-hosts');
    expect(ignoreCall).toBeDefined();
    const args = ignoreCall![1];
    expect(args[0]).toBe('set');
    expect(args[2]).toBe('ignore-hosts');
    // ignoreList 作为单个 argv 元素（含注入向量原样，不被 shell 解析）
    const ignoreList = args[3];
    expect(ignoreList).toContain('evil$(touch /tmp/pwned)');
    expect(ignoreList).toContain('`id`');
    expect(ignoreList).toContain('a;rm -rf ~');

    // 验证未用 exec（shell）下发 ignore-hosts
    const execIgnore = execMock.mock.calls.some(
      (c: unknown[]) => typeof c[0] === 'string' && /ignore-hosts/.test(c[0] as string)
    );
    expect(execIgnore).toBe(false);
  });
});
