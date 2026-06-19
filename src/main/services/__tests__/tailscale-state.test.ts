/**
 * tailscale-state 单测：登录态真值（state 目录）+ 登录成功轮询纯逻辑。
 *
 * - tailscaleStateExists：抽自 singbox-outbound-builder 内部函数，行为须逐字保留
 *   （目录不存在/空 → false，有文件 → true，读失败 → false）。用真实 tmp 目录 + 真实 readdirSync。
 * - pollTailscaleLoginSuccess：check/sleep/isCancelled 全注入 → 不依赖文件系统/墙钟，确定可复现。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// getUserDataPath 依赖 electron app → mock 成可控 tmp 根目录，使 tailscaleStateDir 落到该 tmp。
let tmpRoot = '';
jest.mock('../../utils/paths', () => ({
  getUserDataPath: () => tmpRoot,
}));

import {
  tailscaleStateDir,
  tailscaleStateExists,
  pollTailscaleLoginSuccess,
} from '../tailscale-state';

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

describe('pollTailscaleLoginSuccess', () => {
  const noSleep = () => Promise.resolve();

  it('首次 check 即 true → success（零等待）', async () => {
    const check = jest.fn(() => true);
    const sleep = jest.fn(noSleep);
    const result = await pollTailscaleLoginSuccess({ check, sleep });
    expect(result).toBe('success');
    expect(check).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('第 3 次 check 才 true → success', async () => {
    let n = 0;
    const check = jest.fn(() => {
      n++;
      return n >= 3;
    });
    const result = await pollTailscaleLoginSuccess({ check, sleep: noSleep, intervalMs: 10 });
    expect(result).toBe('success');
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('始终 false 到上限 → timeout（按 interval/timeout 算 check 次数）', async () => {
    const check = jest.fn(() => false);
    // intervalMs=10, timeoutMs=30 → waited 走 0,10,20,30；check 在 0/10/20/30 各一次，30 时 waited>=timeout 返 timeout。
    const result = await pollTailscaleLoginSuccess({
      check,
      sleep: noSleep,
      intervalMs: 10,
      timeoutMs: 30,
    });
    expect(result).toBe('timeout');
    expect(check).toHaveBeenCalledTimes(4);
  });

  it('支持 async check（Promise<boolean>）', async () => {
    let n = 0;
    const check = jest.fn(async () => ++n >= 2);
    const result = await pollTailscaleLoginSuccess({ check, sleep: noSleep, intervalMs: 5 });
    expect(result).toBe('success');
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('isCancelled → cancelled（中止轮询，不再 check）', async () => {
    const check = jest.fn(() => false);
    const result = await pollTailscaleLoginSuccess({
      check,
      sleep: noSleep,
      isCancelled: () => true,
    });
    expect(result).toBe('cancelled');
    expect(check).not.toHaveBeenCalled();
  });

  it('轮到第 2 次时被取消 → cancelled', async () => {
    let polls = 0;
    const check = jest.fn(() => false);
    const result = await pollTailscaleLoginSuccess({
      check,
      sleep: noSleep,
      intervalMs: 5,
      isCancelled: () => polls++ >= 1, // 第一次进入 false，第二次 true
    });
    expect(result).toBe('cancelled');
    expect(check).toHaveBeenCalledTimes(1);
  });
});
