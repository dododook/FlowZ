/**
 * win-tun-adapter 释放门控纯逻辑单测（issue #159）。
 * 注入 probe/sleep，零真实计时器、零真实网卡：验早退 / 超时 fail-open / 轮次与 sleep 次数。
 * 真实 Get-NetAdapter 探测属真机项（无 Windows 环境，不在单测覆盖）。
 */
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));

// B3 快检读 os.networkInterfaces()，而 Node 的 os 模块属性不可重定义（jest.spyOn 会抛
// `Cannot redefine property`）→ 只能整模块 mock。默认实现即真实实现，故其余用例行为不变。
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, networkInterfaces: jest.fn(actual.networkInterfaces) };
});

import { execFile } from 'child_process';
import * as os from 'os';
import {
  probeWinIpv4AddressUsage,
  probeWinTunAdapterPresence,
  probeWinTunAdapterPresent,
  nodeSeesInterface,
  waitForAdapterReleased,
  waitForAdapterPresent,
  recordAdapterPresence,
  isPersistentTunFailure,
  type AdapterPresence,
  type TunAdapterObservation,
} from '../win-tun-adapter';
import { powershellPath } from '../../utils/win-system32';
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

// ============================================================================
// issue #324 P0-2：TUN 地址占用探测（Windows 侧 fail-open 的另一半，纯逻辑层的用例杀不到这里）。
// ============================================================================

/** 桩 execFile：按 (err, stdout) 回调；返回本次实际下发的 -Command 串供断言。 */
function stubExecFile(
  err: Error | null,
  stdout: string
): {
  lastCommand: () => string;
  lastArgs: () => string[];
  lastBin: () => string;
  lastOpts: () => Record<string, unknown>;
} {
  let lastArgs: string[] = [];
  let lastBin = '';
  let lastOpts: Record<string, unknown> = {};
  (execFile as unknown as jest.Mock).mockImplementation(
    (
      bin: string,
      args: string[],
      opts: Record<string, unknown>,
      cb: (e: Error | null, o: string) => void
    ) => {
      lastArgs = args;
      lastBin = bin;
      lastOpts = opts;
      cb(err, stdout);
      return undefined as never;
    }
  );
  return {
    lastBin: () => lastBin,
    lastOpts: () => lastOpts,
    // 脚本作为单个 argv 元素经 -Command 传入，直接取回供断言。
    lastCommand: () => {
      const i = lastArgs.indexOf('-Command');
      return i < 0 || i + 1 >= lastArgs.length ? '' : lastArgs[i + 1];
    },
    lastArgs: () => lastArgs,
  };
}

/**
 * 探测链路可用时的 stdout：哨兵首行 + 若干结果行。
 * 直接写裸结果（不带哨兵）的用例一律等价于「脚本没跑到哨兵那行」，必须落 unknown——这正是 #324 真机缺陷的守卫点。
 */
function okStdout(...lines: string[]): string {
  return ['PROBE_OK', ...lines].join('\r\n') + '\r\n';
}

/**
 * 真机实证过的脚本原文（逐字，issue #324）。
 *
 * **为什么是全文精确断言，而不是若干条 toContain/顺序断言**：这个字符串是与 `powershell.exe` 的**契约**，
 * 它的每一段都在 Windows 真机上被实际执行验证过（空闲地址→free、占用→in-use、网卡不存在→absent、
 * 网卡存在→present、CIM 被拦→unknown 五态）。子串与顺序断言挡不住产出侧被改坏——独立 review 用 38 条
 * 变异实测出 15 条逃逸，其中 8 条会在真机重新触发 #324 的 P0，例如：
 *   - 删 `foreach ($x in $r) { Write-Output $x }` → 结果行永不输出 → 恒 free + 恒 absent（原始 P0 原样回归）
 *   - 删 `Select-Object -ExpandProperty` → 同上
 *   - 把哨兵提出 if 块、留下空的 `if (...) { }` → 判据文本还在、顺序还对，但已不再门控哨兵
 *   - `$ErrorActionPreference='Stop'` + 删内联 `-ErrorAction` → 恒 unknown
 *   - `Get-NetAdapter` 拼写错（`indexOf` 返 -1，与正数比反而「通过」——顺序断言在最该报警时失效）
 *
 * **改动此处的纪律**：脚本文本变了就等于契约变了，必须重新在 Windows 真机上验完五态再同步这里的常量。
 * 合法重构（改缩进、`-e` 简写、单行 join）也会让本组用例失败——**那是设计意图**：它逼你回去重验，
 * 而不是让一次「看起来无害」的重写把避让机制静默改回失效状态。
 */
const SCRIPT_IP_PLAIN = `$ErrorActionPreference = 'SilentlyContinue'
$Error.Clear()
try {
  $r = @(Get-NetIPAddress -IPAddress '172.19.0.1' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty IPAddress)
  if (@($Error | Where-Object { $_.CategoryInfo.Category -ne 'ObjectNotFound' }).Count -eq 0) {
    Write-Output 'PROBE_OK'
    foreach ($x in $r) { Write-Output $x }
  }
} catch { }
exit 0`;

const SCRIPT_IP_WITH_ALIAS = `$ErrorActionPreference = 'SilentlyContinue'
$Error.Clear()
try {
  $r = @(Get-NetIPAddress -IPAddress '172.19.0.1' -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -ne 'flowz-tun0' } | Select-Object -ExpandProperty IPAddress)
  if (@($Error | Where-Object { $_.CategoryInfo.Category -ne 'ObjectNotFound' }).Count -eq 0) {
    Write-Output 'PROBE_OK'
    foreach ($x in $r) { Write-Output $x }
  }
} catch { }
exit 0`;

const SCRIPT_ADAPTER = `$ErrorActionPreference = 'SilentlyContinue'
$Error.Clear()
try {
  $r = @(Get-NetAdapter -Name 'flowz-tun0' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
  if (@($Error | Where-Object { $_.CategoryInfo.Category -ne 'ObjectNotFound' }).Count -eq 0) {
    Write-Output 'PROBE_OK'
    foreach ($x in $r) { Write-Output $x }
  }
} catch { }
exit 0`;

describe('PowerShell 探测脚本形态（#324 真机契约）', () => {
  // 姊妹腿：与 `describe('probeWinTunAdapterPresence')` 同一条理由——本组守的是**外部进程契约文本**
  // （PowerShell 全文 `toBe`），被 B3 快检短路掉的话连脚本都不会生成，失效代价比那组更高。
  beforeEach(() => mockIfaces(() => ({})));

  beforeEach(() => (execFile as unknown as jest.Mock).mockReset());

  it('地址探测（无别名）生成的脚本逐字等于真机实证过的原文', async () => {
    const h = stubExecFile(null, okStdout());
    await probeWinIpv4AddressUsage('172.19.0.1');
    expect(h.lastCommand()).toBe(SCRIPT_IP_PLAIN);
  });

  it('地址探测（带别名排除）生成的脚本逐字等于真机实证过的原文', async () => {
    const h = stubExecFile(null, okStdout());
    await probeWinIpv4AddressUsage('172.19.0.1', 'flowz-tun0');
    expect(h.lastCommand()).toBe(SCRIPT_IP_WITH_ALIAS);
  });

  it('网卡探测生成的脚本逐字等于真机实证过的原文', async () => {
    const h = stubExecFile(null, okStdout());
    await probeWinTunAdapterPresence('flowz-tun0');
    expect(h.lastCommand()).toBe(SCRIPT_ADAPTER);
  });

  /**
   * argv 形态门（脚本文本里没有，故单独断言）。
   *
   * **判据改写记录（2026-08-26）**：原门断言的是「必须走 `-EncodedCommand`」，理由写的是「命令行转义面 +
   * 脚本可含多行/exit」。真机实测推翻了它的性价比——`-EncodedCommand` 让 `CreateProcessW` **同步阻塞主线程**
   * 2.3–4.7s/次（同脚本改 `-Command` 后 8–10ms，见 runPsProbe 头注）。改判据前先核对新旧判据的强弱：
   *
   * | 输入 | 旧判据（-EncodedCommand） | 新判据（单 argv 元素 + 校验器） | 差 |
   * |---|---|---|---|
   * | `flowz-tun0`（合法） | 正常探测 | 正常探测 | 无 |
   * | 别名含 `'` | 调用方 `''` 转义后落单引号串 | 同左（转义逻辑未动） | 无 |
   * | 别名含 `"` / 空格 / 换行 | base64 后不经命令行解析 | `execFile` 不过 shell，仍是**一个** argv 元素，不经命令行解析 | 无 |
   * | 别名含 PowerShell 语法（`$(...)`） | **不拦**（编码只消命令行层，语法层照旧） | **不拦**（同左） | 无 |
   * | 非法 IP 字面量 | 校验器早退 unknown，不 spawn | 同左 | 无 |
   *
   * 结论：编码传参消掉的只有**命令行层**，而 `execFile`（无 shell）本来就没有那一层——两者对输入的约束
   * 逐格相同，故换传参方式**不放宽任何东西**。下面三条把「逐格相同」落成门。
   */
  it('脚本以单个 argv 元素经 -Command 传入（argv 边界即转义边界）', async () => {
    const h = stubExecFile(null, okStdout());
    await probeWinIpv4AddressUsage('172.19.0.1');
    // 变异守卫：若脚本被按行/按空格拆成多个参数，argv 长度会变，且 PowerShell 会按命令行规则重新解析它们。
    expect(h.lastArgs()).toEqual(['-NoProfile', '-NonInteractive', '-Command', SCRIPT_IP_PLAIN]);
  });

  it('不得回退 -EncodedCommand（真机实测：每次 2.3–4.7s 主进程同步冻结）', async () => {
    // 这条守的是**性能**性质，单测测不出耗时，故按传参形态钉。数据与理由见 runPsProbe 头注。
    const h = stubExecFile(null, okStdout());
    await probeWinIpv4AddressUsage('172.19.0.1');
    expect(h.lastArgs()).not.toContain('-EncodedCommand');
  });

  it('恶意别名：引号被转义、其余字符原样落在单引号串内，且 argv 仍是一个元素', async () => {
    const h = stubExecFile(null, okStdout());
    // 同时含单引号、双引号、空格、换行——覆盖上表「别名含 `"` / 空格 / 换行」与「含 `'`」两行。
    await probeWinTunAdapterPresence('a\'b"c d\ne');
    expect(h.lastArgs()).toHaveLength(4);
    expect(h.lastCommand()).toContain(`Get-NetAdapter -Name 'a''b"c d\ne'`);
  });

  it('spawn 的是 powershellPath() 的绝对路径，且带 timeout / windowsHide', async () => {
    // 变异守卫：删 `timeout: 4000` → 被杀软挂住的 PowerShell 永不回调，起核卡死无兜底；
    // 把 bin 换成裸名 'powershell' → PATH 劫持面。两者单测都能钉。
    const h = stubExecFile(null, okStdout());
    await probeWinIpv4AddressUsage('172.19.0.1');
    expect(h.lastBin()).toBe(powershellPath());
    expect(h.lastOpts()).toMatchObject({ timeout: 4000, windowsHide: true });
  });
});

describe('probeWinIpv4AddressUsage', () => {
  beforeEach(() => (execFile as unknown as jest.Mock).mockReset());

  it('查到该地址 → in-use', async () => {
    stubExecFile(null, okStdout('172.19.0.1'));
    await expect(probeWinIpv4AddressUsage('172.19.0.1')).resolves.toBe('in-use');
  });

  it('哨兵在、无结果行 → free（证明探测链路可用）', async () => {
    // 变异守卫：把 hit 判定反转 → 本例与上例同时失败。
    stubExecFile(null, okStdout());
    await expect(probeWinIpv4AddressUsage('172.19.0.1')).resolves.toBe('free');
  });

  it('stdout 空且无哨兵 → unknown，绝不是 free（#324 真机缺陷的核心守卫）', async () => {
    // 旧实现在这里判 free，而真机给的正是「stdout 空」+ 退出码 1。哨兵把「查询确实跑过」变成可观测事实，
    // 没有它就不许得出 free——否则 PowerShell 被杀软拦住的机器会被当成「所有候选都空闲」。
    // 变异守卫：删掉 runPsProbe 里的 `if (at < 0)` 短路 → 本例得到 free 而失败。
    stubExecFile(null, '');
    await expect(probeWinIpv4AddressUsage('172.19.0.1')).resolves.toBe('unknown');
  });

  it('有输出但无哨兵（脚本中途夭折 / 输出被截断）→ unknown', async () => {
    stubExecFile(null, '172.19.0.1\r\n');
    await expect(probeWinIpv4AddressUsage('172.19.0.1')).resolves.toBe('unknown');
  });

  it('PowerShell 失败/超时 → unknown，绝不是 free 也绝不是 in-use', async () => {
    // 变异守卫：err 分支 resolve('free') 或 'in-use' → 本例失败。这是 fail-open 在 Windows 侧的落点：
    // 判 free 会让预检对被杀软拦住的机器形同虚设；判 in-use 会让所有这类机器无谓换地址。
    stubExecFile(new Error('spawn ENOENT'), '');
    await expect(probeWinIpv4AddressUsage('172.19.0.1')).resolves.toBe('unknown');
  });

  it('err 非 null 且 stdout 已有完整哨兵输出（超时杀进程但输出已到）→ 仍是 unknown', async () => {
    // 这个输入组合此前零覆盖，而它恰恰是 execFile 超时的真实形态：进程被 SIGTERM 前 stdout 已经写完。
    // 变异守卫：把 err 短路改成 `if (err && !stdout.includes(哨兵))` → 本例得到 in-use 而失败。
    // 为什么必须是 unknown：进程被中途杀掉时，stdout 可能只是「看起来完整」，不能据此判定查询真的跑完了。
    stubExecFile(new Error('ETIMEDOUT'), okStdout('172.19.0.1'));
    await expect(probeWinIpv4AddressUsage('172.19.0.1')).resolves.toBe('unknown');
    stubExecFile(new Error('ETIMEDOUT'), okStdout());
    await expect(probeWinIpv4AddressUsage('172.19.0.1')).resolves.toBe('unknown');
  });

  it('多行输出里按整行 trim 精确匹配，不做子串匹配', async () => {
    stubExecFile(null, okStdout('172.19.0.10', '172.19.0.100'));
    await expect(probeWinIpv4AddressUsage('172.19.0.1')).resolves.toBe('free');
    stubExecFile(null, okStdout('10.0.0.5', '  172.19.0.1  '));
    await expect(probeWinIpv4AddressUsage('172.19.0.1')).resolves.toBe('in-use');
  });

  it('非法 IP 字面量 → unknown 且不 spawn（命令拼接面的纵深防御）', async () => {
    stubExecFile(null, okStdout('x'));
    await expect(probeWinIpv4AddressUsage("1.2.3.4'; rm -rf /")).resolves.toBe('unknown');
    expect(execFile as unknown as jest.Mock).not.toHaveBeenCalled();
  });

  it('传入自家接口别名 → 命令里带 InterfaceAlias 排除（H1：自家残留不算冲突）', async () => {
    const h = stubExecFile(null, okStdout());
    await probeWinIpv4AddressUsage('172.19.0.1', 'flowz-tun0');
    expect(h.lastCommand()).toContain("$_.InterfaceAlias -ne 'flowz-tun0'");
  });

  it('不传别名 → 查询管道里无 InterfaceAlias 过滤（保持最简查询）', async () => {
    // 断言 InterfaceAlias 而非 Where-Object：脚本模板自身的 ObjectNotFound 判据也用 Where-Object，
    // 拿它做否定断言等于把「有没有 alias 过滤」寄托在一个与语义无关的词上。
    const h = stubExecFile(null, okStdout());
    await probeWinIpv4AddressUsage('172.19.0.1');
    expect(h.lastCommand()).not.toContain('InterfaceAlias');
  });

  it('别名里的单引号被转义（PowerShell 字面量闭合）', async () => {
    const h = stubExecFile(null, okStdout());
    await probeWinIpv4AddressUsage('172.19.0.1', "it's");
    expect(h.lastCommand()).toContain("-ne 'it''s'");
  });
});

/**
 * `probeWinTunAdapterPresence` 的 execFile 级契约（此前只有注入桩的 waitForAdapterPresent 用例，
 * 这一层从未被覆盖——#324 的同源缺陷正是从这个缺口漏出去的）。
 */
describe('probeWinTunAdapterPresence', () => {
  beforeEach(() => (execFile as unknown as jest.Mock).mockReset());
  // 本组验的是 **PowerShell 契约**（哨兵/退出码/三态），必须让 B3 快检恒不命中，否则判据会被短路吃掉。
  // 不加这行的话：本机 Linux 无 `flowz-tun0` 恰好全绿，但在真跑着 FlowZ 的 Windows 开发机上（那里确实存在
  // 同名接口）这 8 条会集体短路成 present —— 一个只在特定机器上失效的门，比没有门更坏。
  beforeEach(() => mockIfaces(() => ({})));

  it('哨兵在、命中本名 → present', async () => {
    stubExecFile(null, okStdout('flowz-tun0'));
    await expect(probeWinTunAdapterPresence('flowz-tun0')).resolves.toBe('present');
  });

  it('哨兵在、无结果行 → absent（据此可判「从未创建」→ 硬闸失败本腿）', async () => {
    // 真机上这正是「网卡不存在」的场景，旧实现因退出码 1 落 unknown → waitForAdapterPresent 的 sawAbsent
    // 恒 false → outcome 恒 'unknown' → 硬闸永远 fail-open，#327 的就绪验证形同虚设。
    stubExecFile(null, okStdout());
    await expect(probeWinTunAdapterPresence('flowz-tun0')).resolves.toBe('absent');
  });

  it('无哨兵 → unknown，绝不是 absent（不把「查不了」误判成「确实没有」）', async () => {
    stubExecFile(null, '');
    await expect(probeWinTunAdapterPresence('flowz-tun0')).resolves.toBe('unknown');
  });

  it('PowerShell 失败/超时 → unknown（fail-open，绝不据此判终态失败）', async () => {
    stubExecFile(new Error('spawn ENOENT'), '');
    await expect(probeWinTunAdapterPresence('flowz-tun0')).resolves.toBe('unknown');
  });

  it('按整行精确匹配，同前缀网卡名不误判', async () => {
    stubExecFile(null, okStdout('flowz-tun00', 'flowz-tun0-old'));
    await expect(probeWinTunAdapterPresence('flowz-tun0')).resolves.toBe('absent');
  });

  it('网卡名里的单引号被转义（PowerShell 字面量闭合）', async () => {
    const h = stubExecFile(null, okStdout());
    await probeWinTunAdapterPresence("it's");
    expect(h.lastCommand()).toContain("-Name 'it''s'");
  });

  it('布尔版 probeWinTunAdapterPresent：absent/unknown 均塌成 false（#159 反向门 fail-open）', async () => {
    stubExecFile(null, okStdout());
    await expect(probeWinTunAdapterPresent('flowz-tun0')).resolves.toBe(false);
    stubExecFile(null, '');
    await expect(probeWinTunAdapterPresent('flowz-tun0')).resolves.toBe(false);
    stubExecFile(null, okStdout('flowz-tun0'));
    await expect(probeWinTunAdapterPresent('flowz-tun0')).resolves.toBe(true);
  });
});

/**
 * B3：零 spawn 快检。合同的全部要害在于**它只被允许产出肯定结论**——看不见一律回落 PowerShell，
 * 绝不据此判 absent（否则 #159 释放门恒放行、#324 正向门把健康机器判成终态失败）。
 */
/** 把 os.networkInterfaces 换成给定实现；用完 restoreIfaces 还原到真实实现。 */
function mockIfaces(impl: () => unknown): void {
  (os.networkInterfaces as unknown as jest.Mock).mockImplementation(impl);
}
function restoreIfaces(): void {
  (os.networkInterfaces as unknown as jest.Mock).mockImplementation(
    jest.requireActual('os').networkInterfaces
  );
}

describe('nodeSeesInterface（B3 快检）', () => {
  afterEach(restoreIfaces);

  const withAddr = [{ address: '172.19.0.1' }] as unknown as ReturnType<
    typeof os.networkInterfaces
  >[string];

  it('枚举里有本名且带地址 → true', () => {
    expect(nodeSeesInterface('flowz-tun0', { 'flowz-tun0': withAddr })).toBe(true);
  });

  it('枚举里没有本名 → false（含义是「说不了」，由调用方回落 PowerShell）', () => {
    expect(nodeSeesInterface('flowz-tun0', { 以太网: withAddr })).toBe(false);
  });

  it('键在但无地址（空数组 / undefined）→ false：无地址不构成肯定结论', () => {
    expect(nodeSeesInterface('flowz-tun0', { 'flowz-tun0': [] as never })).toBe(false);
    expect(nodeSeesInterface('flowz-tun0', { 'flowz-tun0': undefined })).toBe(false);
  });

  it('名字为空 → false（不拿空串去撞枚举）', () => {
    expect(nodeSeesInterface('', { '': withAddr })).toBe(false);
  });

  it('枚举本身抛错 → false（说不了，绝不冒充结论）', () => {
    mockIfaces(() => {
      throw new Error('boom');
    });
    expect(nodeSeesInterface('flowz-tun0')).toBe(false);
  });
});

describe('probeWinTunAdapterPresence — B3 短路接线', () => {
  afterEach(restoreIfaces);

  it('Node 看得见 → 直接 present，且**零 spawn**（省掉真机实测 ~950ms 的那次 PowerShell）', async () => {
    (execFile as unknown as jest.Mock).mockClear();
    mockIfaces(() => ({ 'flowz-tun0': [{ address: '172.19.0.1' }] }));

    await expect(probeWinTunAdapterPresence('flowz-tun0')).resolves.toBe('present');
    expect(execFile as unknown as jest.Mock).not.toHaveBeenCalled();
  });

  it('Node 看不见 → 仍回落 PowerShell 由它给权威结论（absent 只能来自 PS）', async () => {
    (execFile as unknown as jest.Mock).mockClear();
    mockIfaces(() => ({}));
    (execFile as unknown as jest.Mock).mockImplementation(
      (_c: string, _a: string[], _o: unknown, cb: (e: unknown, out: string) => void) =>
        cb(null, 'PROBE_OK\n')
    );

    await expect(probeWinTunAdapterPresence('flowz-tun0')).resolves.toBe('absent');
    expect(execFile as unknown as jest.Mock).toHaveBeenCalled();
  });

  it('布尔版（#159 释放门）继承短路：Node 看见 → true 且零 spawn', async () => {
    (execFile as unknown as jest.Mock).mockClear();
    mockIfaces(() => ({ 'flowz-tun0': [{ address: '172.19.0.1' }] }));

    await expect(probeWinTunAdapterPresent('flowz-tun0')).resolves.toBe(true);
    expect(execFile as unknown as jest.Mock).not.toHaveBeenCalled();
  });
});
