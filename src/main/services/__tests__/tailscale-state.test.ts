/**
 * tailscale-state 单测：state 目录路径 + 存在性判定（1.14 起仅供 buildTailscaleEndpoint 的 state_directory
 * 与 tailscaleEndpointInRunningCore 双写防护用；登录态本身已迁移到 api STATUS 流）。
 *
 * - tailscaleStateExists：行为须逐字保留（目录不存在/空 → false，有文件 → true，读失败 → false）。
 *   用真实 tmp 目录 + 真实 readdirSync。
 * 登录成功轮询（pollTailscaleLoginSuccess）已剥离（stateExists 误判未认证为已登录是 #132 根因），相应测试一并移除。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// getUserDataPath 依赖 electron app → mock 成可控 tmp 根目录，使 tailscaleStateDir 落到该 tmp。
let tmpRoot = '';
jest.mock('../../utils/paths', () => ({
  getUserDataPath: () => tmpRoot,
}));

import { tailscaleStateDir, tailscaleStateExists } from '../tailscale-state';

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-ts-state-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('tailscaleStateDir', () => {
  it('= <userData>/tailscale/<serverId>', () => {
    expect(tailscaleStateDir('abc')).toBe(path.join(tmpRoot, 'tailscale', 'abc'));
  });
});

describe('tailscaleStateExists', () => {
  it('目录不存在 → false', () => {
    expect(tailscaleStateExists('nope')).toBe(false);
  });

  it('目录存在但为空 → false', () => {
    fs.mkdirSync(tailscaleStateDir('empty'), { recursive: true });
    expect(tailscaleStateExists('empty')).toBe(false);
  });

  it('目录有会话文件 → true', () => {
    const dir = tailscaleStateDir('logged-in');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tailscaled.state'), 'session');
    expect(tailscaleStateExists('logged-in')).toBe(true);
  });
});
