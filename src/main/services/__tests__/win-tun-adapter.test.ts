/**
 * win-tun-adapter 释放门控纯逻辑单测（issue #159）。
 * 注入 probe/sleep，零真实计时器、零真实网卡：验早退 / 超时 fail-open / 轮次与 sleep 次数。
 * 真实 Get-NetAdapter 探测属真机项（无 Windows 环境，不在单测覆盖）。
 */
import {
  waitForAdapterReleased,
  waitForAdapterPresent,
  recordAdapterPresence,
  isPersistentTunFailure,
  type AdapterPresence,
  type TunAdapterObservation,
} from '../win-tun-adapter';
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

// issue #324：正向 TUN 就绪等待（等适配器「出现」，#159 反向门镜像）。注入三态 probe/sleep，零真实计时器/网卡。
function mkPresenceDeps(seq: Array<AdapterPresence | 'THROW'>): {
  sleeps: number[];
  probeCalls: number;
  deps: { probe: () => Promise<AdapterPresence>; sleep: (ms: number) => Promise<void> };
  meta: { probeCalls: number };
} {
  let i = 0;
  const sleeps: number[] = [];
  const meta = { probeCalls: 0 };
  return {
    sleeps,
    probeCalls: 0,
    meta,
    deps: {
      probe: async () => {
        meta.probeCalls++;
        const v = i < seq.length ? seq[i++] : 'absent';
        if (v === 'THROW') throw new Error('powershell 缺失/被拦');
        return v;
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
  };
}

describe('waitForAdapterPresent (issue #324 正向就绪门)', () => {
  it('网卡当即出现 → 一次探测早退（present，polls=1，零等待）', async () => {
    const { deps, sleeps, meta } = mkPresenceDeps(['present']);
    const r = await waitForAdapterPresent('flowz-tun0', { timeoutMs: 8000, pollMs: 1000 }, deps);
    expect(r.outcome).toBe('present');
    expect(r.polls).toBe(1);
    expect(sleeps).toHaveLength(0);
    expect(meta.probeCalls).toBe(1);
  });

  it('数轮 absent 后出现 → 早退 present（轮次/sleep 对应）', async () => {
    const { deps, sleeps } = mkPresenceDeps(['absent', 'absent', 'present']);
    const r = await waitForAdapterPresent('flowz-tun0', { timeoutMs: 8000, pollMs: 1000 }, deps);
    expect(r.outcome).toBe('present');
    expect(r.polls).toBe(3);
    expect(sleeps).toEqual([1000, 1000]); // 前两轮 absent 后各 sleep，第三轮 present 即退
  });

  it('始终 absent（探测可用）→ absent-timeout（可据此硬闸/判持续性）', async () => {
    const { deps } = mkPresenceDeps(Array(20).fill('absent'));
    const r = await waitForAdapterPresent('flowz-tun0', { timeoutMs: 3000, pollMs: 1000 }, deps);
    expect(r.outcome).toBe('absent-timeout');
  });

  it('始终 unknown（探测失败）→ unknown（fail-open，绝不据此判失败）', async () => {
    const { deps } = mkPresenceDeps(Array(20).fill('unknown'));
    const r = await waitForAdapterPresent('flowz-tun0', { timeoutMs: 3000, pollMs: 1000 }, deps);
    expect(r.outcome).toBe('unknown');
  });

  it('probe 抛错（PS 缺/被拦）全程 → unknown（fail-open，捕获 throw）', async () => {
    const { deps } = mkPresenceDeps(Array(20).fill('THROW'));
    const r = await waitForAdapterPresent('flowz-tun0', { timeoutMs: 3000, pollMs: 1000 }, deps);
    expect(r.outcome).toBe('unknown'); // throw 被捕获按 unknown 处理，非崩溃、非误判 absent-timeout
  });

  it('混入一次 clean absent → absent-timeout 压过零星 unknown（证明探测链路可用）', async () => {
    // 全程未 present；出现过 clean absent（PS 可用）+ 若干 unknown → 判 absent-timeout（可判持续性），非 fail-open。
    const { deps } = mkPresenceDeps(['unknown', 'absent', 'unknown', 'unknown']);
    const r = await waitForAdapterPresent('flowz-tun0', { timeoutMs: 3000, pollMs: 1000 }, deps);
    expect(r.outcome).toBe('absent-timeout');
  });

  it('退化参数（timeout/poll=0）不崩，至少探测一次', async () => {
    const { deps } = mkPresenceDeps(['present']);
    const r = await waitForAdapterPresent('x', { timeoutMs: 0, pollMs: 0 }, deps);
    expect(r.outcome).toBe('present');
  });

  // review High#1：grace 轮询须继承 #176 supersede 纪律——被接管即让位（不 present/不 absent-timeout）。
  it('起始即被接管（isSuperseded=true）→ superseded，零探测（不 stopCore/不判存在）', async () => {
    const { deps, meta } = mkPresenceDeps(Array(20).fill('absent'));
    const r = await waitForAdapterPresent(
      'flowz-tun0',
      { timeoutMs: 8000, pollMs: 1000 },
      { ...deps, isSuperseded: () => true }
    );
    expect(r.outcome).toBe('superseded');
    expect(meta.probeCalls).toBe(0); // 让位先于任何探测
  });

  it('grace 中途被接管 → superseded（不误判 absent-timeout，不据 stale 结果硬闸）', async () => {
    const { deps } = mkPresenceDeps(Array(20).fill('absent'));
    let polls = 0;
    let superseded = false;
    const r = await waitForAdapterPresent(
      'flowz-tun0',
      { timeoutMs: 8000, pollMs: 1000 },
      {
        probe: deps.probe,
        sleep: async () => {
          if (++polls >= 2) superseded = true; // 第 2 轮 sleep 后被更新的 start/stop 接管
        },
        isSuperseded: () => superseded,
      }
    );
    expect(r.outcome).toBe('superseded'); // 变异「grace 不判 supersede」→ 会返回 absent-timeout → 此断言失败
  });
});

describe('recordAdapterPresence (issue #324 sticky tracker)', () => {
  const fresh = (): TunAdapterObservation => ({
    adapterEverSeen: false,
    probeEverConclusive: false,
  });

  it('present → adapterEverSeen + probeEverConclusive 均置真', () => {
    const o = fresh();
    recordAdapterPresence(o, 'present');
    expect(o).toEqual({ adapterEverSeen: true, probeEverConclusive: true });
  });

  it('absent → 仅 probeEverConclusive 置真（证明探测可用），adapterEverSeen 不动', () => {
    const o = fresh();
    recordAdapterPresence(o, 'absent');
    expect(o).toEqual({ adapterEverSeen: false, probeEverConclusive: true });
  });

  it('unknown → 两者皆不动（fail-open，不作数）', () => {
    const o = fresh();
    recordAdapterPresence(o, 'unknown');
    expect(o).toEqual({ adapterEverSeen: false, probeEverConclusive: false });
  });

  it('monotonic：present 后再 absent/unknown 也永不复位 adapterEverSeen（跨腿累计）', () => {
    const o = fresh();
    recordAdapterPresence(o, 'present'); // leg-1 见过
    recordAdapterPresence(o, 'absent'); // leg-2 未见（进程死后适配器消失）
    recordAdapterPresence(o, 'unknown');
    expect(o.adapterEverSeen).toBe(true); // 曾见即 sticky → 判瞬态；变异「每腿复位」会让此断言失败
  });
});

describe('isPersistentTunFailure (issue #324 终态判据 — 分类矩阵穷举)', () => {
  // 矩阵四角（对齐 doc「瞬态 vs 持续性」分类表），穷举逃逸面：
  it('从未见 + 探测可用（clean absent 过）→ true（持续性 TUN init 失败）', () => {
    expect(isPersistentTunFailure({ adapterEverSeen: false, probeEverConclusive: true })).toBe(
      true
    );
  });
  it('曾见适配器 → false（瞬态释放竞态族 #159/#176），即便 conclusive', () => {
    expect(isPersistentTunFailure({ adapterEverSeen: true, probeEverConclusive: true })).toBe(
      false
    );
  });
  it('从未见 + 探测全 unknown（杀软拦 PS）→ false（fail-open，绝不据此判终态）', () => {
    // 变异「删 fail-open（去掉 probeEverConclusive 条件）」→ 此例会误判 true → 被本用例杀死。
    expect(isPersistentTunFailure({ adapterEverSeen: false, probeEverConclusive: false })).toBe(
      false
    );
  });
  it('曾见 + 探测未 conclusive（防御性组合）→ false', () => {
    expect(isPersistentTunFailure({ adapterEverSeen: true, probeEverConclusive: false })).toBe(
      false
    );
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
