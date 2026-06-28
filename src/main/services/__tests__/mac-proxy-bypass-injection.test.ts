/**
 * macOS 系统代理 bypass 命令注入防护单测（攻击面 review H3）。
 *
 * H3：bypass 列表（用户可控：设置 UI 编辑 / 备份导入注入）原用 execAsync shell 字符串拼接
 * → 含 ;/`/$() 的项可命令注入。修复：setproxybypassdomains 改用 execFileAsync 数组参数，
 * 每个 bypass 项作为独立 argv 元素，不经 /bin/sh -c 解析，从根本上消除注入面。
 *
 * 本测试验证：mac enableProxy 下发 setproxybypassdomains 时用 execFile（非 exec），
 * 且 bypass 项含 shell 元字符时作为独立 argv 传递（不被 shell 解析）。
 */
jest.mock('child_process', () => ({
  exec: jest.fn(),
  execFile: jest.fn(),
  execSync: jest.fn(),
}));

jest.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/flowz-test-mac-inj',
    getName: () => 'FlowZ',
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => '/tmp/flowz-test-mac-inj',
  },
  net: {},
}));

import { exec, execFile } from 'child_process';
import { MacOSSystemProxy } from '../SystemProxyManager';

const execMock = exec as unknown as jest.Mock;
const execFileMock = execFile as unknown as jest.Mock;

describe('攻击面 H3：macOS setproxybypassdomains 用 execFile 参数数组（防命令注入）', () => {
  beforeEach(() => {
    execMock.mockReset();
    execFileMock.mockReset();
    // getNetworkServices 内部用 execAsync（exec），返回单个服务让循环跑一轮
    execMock.mockImplementation(
      (cmd: string, cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
        if (/listallnetworkservices/.test(cmd)) {
          cb(null, { stdout: 'An asterisk (*) denotes...\nWi-Fi\n', stderr: '' });
          return;
        }
        cb(null, { stdout: '', stderr: '' });
      }
    );
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (e: null) => void) =>
      cb(null)
    );
  });

  it('含 shell 元字符的 bypass 项作为独立 argv 传递（不经 shell 解析）', async () => {
    const proxy = new MacOSSystemProxy();
    await proxy.enableProxy('127.0.0.1', 7890, 7891, [
      'normal.com',
      'evil;rm -rf ~', // shell 元字符注入向量
      '$(whoami)',
      '`id`',
    ]);

    // setproxybypassdomains 必须走 execFile（参数数组），不能走 exec（shell 字符串）
    const calls = execFileMock.mock.calls as unknown as Array<[string, string[], ...unknown[]]>;
    const bypassCall = calls.find((c) => c[1]?.[0] === '-setproxybypassdomains');
    expect(bypassCall).toBeDefined();
    const args = bypassCall![1]; // argv 数组：['-setproxybypassdomains', service, ...bypassDomains]
    // service + bypass 项作为独立 argv 元素（shell 元字符原样传递，不被解析）
    expect(args[0]).toBe('-setproxybypassdomains');
    expect(args[1]).toBe('Wi-Fi'); // service
    expect(args).toContain('evil;rm -rf ~'); // 注入向量原样作为参数，不触发命令执行
    expect(args).toContain('$(whoami)');
    expect(args).toContain('`id`');

    // 验证未用 exec（shell）下发 setproxybypassdomains
    const execBypass = execMock.mock.calls.some(
      (c: unknown[]) => typeof c[0] === 'string' && /setproxybypassdomains/.test(c[0] as string)
    );
    expect(execBypass).toBe(false);
  });
});
