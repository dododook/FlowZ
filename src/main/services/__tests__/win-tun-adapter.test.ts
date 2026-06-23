/**
 * win-tun-adapter 释放门控纯逻辑单测（issue #159）。
 * 注入 probe/sleep，零真实计时器、零真实网卡：验早退 / 超时 fail-open / 轮次与 sleep 次数。
 * 真实 Get-NetAdapter 探测属真机项（无 Windows 环境，不在单测覆盖）。
 */
import { waitForAdapterReleased } from '../win-tun-adapter';
import { resolveWinTunInterfaceName, FLOWZ_WIN_TUN_INTERFACE } from '../../../shared/tun-interface';
import type { UserConfig } from '../../../shared/types';

function mkDeps(presence: boolean[]): {
  sleeps: number[];
  deps: { probe: () => Promise<boolean>; sleep: (ms: number) => Promise<void> };
} {
  let i = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    deps: {
      probe: async () => (i < presence.length ? presence[i++] : false),
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
  };
}

describe('waitForAdapterReleased', () => {
  it('网卡当即不存在 → 一次探测即放行（polls=1，零等待）', async () => {
    const { deps, sleeps } = mkDeps([false]);
    const r = await waitForAdapterReleased('flowz-tun0', { timeoutMs: 8000, pollMs: 250 }, deps);
    expect(r.released).toBe(true);
    expect(r.polls).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  it('网卡存在数轮后消失 → 早退（released，轮次/ sleep 对应）', async () => {
    const { deps, sleeps } = mkDeps([true, true, false]);
    const r = await waitForAdapterReleased('flowz-tun0', { timeoutMs: 8000, pollMs: 250 }, deps);
    expect(r.released).toBe(true);
    expect(r.polls).toBe(3);
    expect(sleeps).toEqual([250, 250]); // 前两轮 true 后各 sleep 一次，第三轮 false 即退
  });

  it('始终存在 → 超时未释放（released=false，放行交 retry 兜底）', async () => {
    const { deps } = mkDeps(Array(20).fill(true));
    const r = await waitForAdapterReleased('flowz-tun0', { timeoutMs: 1000, pollMs: 250 }, deps);
    expect(r.released).toBe(false);
  });

  it('退化参数（timeout/poll=0）不崩，至少探测一次', async () => {
    const { deps } = mkDeps([false]);
    const r = await waitForAdapterReleased('x', { timeoutMs: 0, pollMs: 0 }, deps);
    expect(r.released).toBe(true);
  });
});

describe('resolveWinTunInterfaceName', () => {
  const cfg = (over: Record<string, unknown>): UserConfig => over as unknown as UserConfig;

  it('缺省 → FLOWZ_WIN_TUN_INTERFACE(flowz-tun0)', () => {
    expect(resolveWinTunInterfaceName(cfg({}))).toBe(FLOWZ_WIN_TUN_INTERFACE);
    expect(FLOWZ_WIN_TUN_INTERFACE).toBe('flowz-tun0');
  });

  it('自定义 interfaceName 覆盖缺省', () => {
    expect(resolveWinTunInterfaceName(cfg({ tunConfig: { interfaceName: 'my-tun' } }))).toBe(
      'my-tun'
    );
  });

  it('空白/空串自定义 → 回落缺省', () => {
    expect(resolveWinTunInterfaceName(cfg({ tunConfig: { interfaceName: '   ' } }))).toBe(
      FLOWZ_WIN_TUN_INTERFACE
    );
  });

  it('非法字符/超长自定义 → 回落缺省（防内核 FATAL / Get-NetAdapter 匹配失效）', () => {
    for (const bad of ['bad name!', 'tun/0', '名字', 'a'.repeat(33), 'x;y']) {
      expect(resolveWinTunInterfaceName(cfg({ tunConfig: { interfaceName: bad } }))).toBe(
        FLOWZ_WIN_TUN_INTERFACE
      );
    }
  });

  it('合法自定义（字母数字/连字符/下划线，≤32）→ 采用', () => {
    expect(resolveWinTunInterfaceName(cfg({ tunConfig: { interfaceName: 'flowz_tun-1' } }))).toBe(
      'flowz_tun-1'
    );
  });
});
