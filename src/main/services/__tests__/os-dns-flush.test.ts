/**
 * flushOsDnsCache 单测（node env，依赖全注入）。覆盖：
 *  - 三平台分支：darwin helper 成功（不降级）/ partial / helper 失败降级用户级 dscacheutil / win32 / linux；
 *  - 不变量「永不 reject」——失败经**返回值**上报（issue #367 前是吞成一行 warn）；
 *  - 结果契约：ok / skipped（平台 no-op ≠ 成功）/ partial（macOS HUP 未打成）/ detail 单行化；
 *  - classifyExecFailure 分类表与判定顺序；
 *  - shouldFlushOnLinkChange 限频边界（issue #368）。
 */
import {
  flushOsDnsCache,
  classifyExecFailure,
  monotonicNowMs,
  LINK_CHANGE_FLUSH_FAIL_STREAK_LIMIT,
  linkChangeFlushRetryDelayMs,
  sanitizeDetail,
  shouldFlushOnLinkChange,
  shouldSuppressLinkChangeFlush,
  LINK_CHANGE_FLUSH_MIN_INTERVAL_MS,
} from '../os-dns-flush';
import type { OsDnsFlushFailureReason } from '../os-dns-flush';

describe('flushOsDnsCache', () => {
  it('darwin：helper flush-dns 成功 → 不降级（exec 不被调用）', async () => {
    const exec = jest.fn();
    const helper = jest.fn().mockResolvedValue({ ok: true });
    const log = jest.fn();
    await flushOsDnsCache({ platform: 'darwin', exec, helperFlushDns: helper, log });
    expect(helper).toHaveBeenCalledTimes(1);
    expect(exec).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('helper root'));
  });

  it('darwin：helper partial（dscacheutil 成功、仅 HUP 失败）→ 不降级（exec 不被调），warn 留痕含详情', async () => {
    const exec = jest.fn();
    const helper = jest
      .fn()
      .mockResolvedValue({ ok: true, partial: 'OK flushed-partial killall-hup exit status 1' });
    const log = jest.fn();
    await flushOsDnsCache({ platform: 'darwin', exec, helperFlushDns: helper, log });
    expect(exec).not.toHaveBeenCalled(); // 用户级同样无权 HUP，重复降级无益
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('killall-hup'));
  });

  it('darwin：helper 失败（旧 proto 回 ERR unknown）→ 降级用户级 dscacheutil', async () => {
    const exec = jest.fn().mockResolvedValue(undefined);
    const helper = jest.fn().mockResolvedValue({ ok: false, error: 'ERR unknown' });
    const log = jest.fn();
    await flushOsDnsCache({ platform: 'darwin', exec, helperFlushDns: helper, log });
    expect(exec).toHaveBeenCalledWith('/usr/bin/dscacheutil', ['-flushcache'], expect.any(Number));
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('降级'));
  });

  it('darwin：无 helper（null，未装/非 TUN 场景）→ 直接用户级 dscacheutil', async () => {
    const exec = jest.fn().mockResolvedValue(undefined);
    await flushOsDnsCache({ platform: 'darwin', exec, helperFlushDns: null });
    expect(exec).toHaveBeenCalledWith('/usr/bin/dscacheutil', ['-flushcache'], expect.any(Number));
  });

  it('darwin：helper reject（契约防御）→ 仍降级、不外抛', async () => {
    const exec = jest.fn().mockResolvedValue(undefined);
    const helper = jest.fn().mockRejectedValue(new Error('socket boom'));
    // 不变量仍是「永不 reject」；返回值从 void 改为结果对象（issue #367）→ 断言随之从 toBeUndefined
    // 改为「resolve 且降级腿走到」，意图不变且更强（原断言只能证明没抛，证不了降级发生）。
    await expect(
      flushOsDnsCache({ platform: 'darwin', exec, helperFlushDns: helper })
    ).resolves.toMatchObject({ ok: true });
    expect(exec).toHaveBeenCalledWith('/usr/bin/dscacheutil', ['-flushcache'], expect.any(Number));
  });

  it('win32：ipconfig /flushdns（无需提权，不碰 helper）', async () => {
    const exec = jest.fn().mockResolvedValue(undefined);
    const helper = jest.fn();
    await flushOsDnsCache({ platform: 'win32', exec, helperFlushDns: helper });
    expect(exec).toHaveBeenCalledWith('ipconfig', ['/flushdns'], expect.any(Number));
    expect(helper).not.toHaveBeenCalled();
  });

  it('linux：resolvectl flush-caches', async () => {
    const exec = jest.fn().mockResolvedValue(undefined);
    await flushOsDnsCache({ platform: 'linux', exec });
    expect(exec).toHaveBeenCalledWith('resolvectl', ['flush-caches'], expect.any(Number));
  });

  it('exec 抛错（如无 systemd-resolved）→ 永不 reject，仍 warn，且失败经返回值上报', async () => {
    const exec = jest.fn().mockRejectedValue(new Error('ENOENT'));
    const log = jest.fn();
    // 原断言 resolves.toBeUndefined 只能证明「没抛」；issue #367 的要求是「失败可被上层观测」，
    // 故改为断言返回值本身——旧口径在新契约下无法区分「成功」与「失败被吞」。
    await expect(flushOsDnsCache({ platform: 'linux', exec, log })).resolves.toMatchObject({
      ok: false,
    });
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('ENOENT'));
  });
});

describe('flushOsDnsCache — 结果上报（issue #367）', () => {
  it('成功路径返回 ok:true + detail（linux）', async () => {
    const exec = jest.fn().mockResolvedValue(undefined);
    const r = await flushOsDnsCache({ platform: 'linux', exec });
    expect(r).toEqual({ ok: true, detail: 'resolvectl flush-caches' });
  });

  it('不支持的平台 → ok:true + skipped:true（**不是**刷新成功，诊断侧据此区分）', async () => {
    const exec = jest.fn();
    const r = await flushOsDnsCache({ platform: 'freebsd' as NodeJS.Platform, exec });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it('linux 权限被拒 → reason=permission-denied，且 detail 带可操作提示（区别于命令缺失）', async () => {
    const err = Object.assign(new Error('Command failed'), {
      stderr: 'Interactive authentication required.',
    });
    const exec = jest.fn().mockRejectedValue(err);
    const log = jest.fn();
    const r = await flushOsDnsCache({ platform: 'linux', exec, log });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('permission-denied');
    expect(r.detail).toContain('polkit');
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('permission-denied'));
  });

  it('linux 命令缺失 → reason=command-missing，提示语与权限被拒不同（可操作性不同）', async () => {
    const err = Object.assign(new Error('spawn resolvectl ENOENT'), { code: 'ENOENT' });
    const exec = jest.fn().mockRejectedValue(err);
    const r = await flushOsDnsCache({ platform: 'linux', exec });
    expect(r.reason).toBe('command-missing');
    expect(r.detail).not.toContain('polkit');
  });

  it('超时 → reason=timeout', async () => {
    const err = Object.assign(new Error('Command failed'), { killed: true });
    const exec = jest.fn().mockRejectedValue(err);
    const r = await flushOsDnsCache({ platform: 'linux', exec });
    expect(r.reason).toBe('timeout');
  });

  it('darwin helper partial → ok:true 且 partial 单独成字段（不埋进 detail，供渲染区分「部分成功」）', async () => {
    const helper = jest.fn().mockResolvedValue({ ok: true, partial: 'killall-hup exit status 1' });
    const r = await flushOsDnsCache({ platform: 'darwin', helperFlushDns: helper });
    expect(r.ok).toBe(true);
    expect(r.partial).toContain('killall-hup');
    // detail 是 headline 文案，不该塞进原文——否则渲染侧无法把「部分成功」与真成功分开。
    expect(r.detail).not.toContain('killall-hup');
  });

  it('超长 stderr 下可操作提示不被截断（提示是分类的全部价值，不能放在截断最脆弱的位置）', async () => {
    const err = Object.assign(new Error(`Command failed: ${'x'.repeat(600)}`), {
      stderr: 'Interactive authentication required.',
    });
    const exec = jest.fn().mockRejectedValue(err);
    const r = await flushOsDnsCache({ platform: 'linux', exec });
    expect(r.reason).toBe('permission-denied');
    expect(r.detail).toContain('polkit'); // hint 在尾部且完整
    expect(r.detail).toContain('…'); // raw 确实被截断了（反向对照：没截断则本条无信息量）
  });

  it('失败 detail 单行化：execFile 的 message 恒含换行 + stderr，多行会撑破诊断报告的 bullet', async () => {
    const err = new Error(
      'Command failed: resolvectl flush-caches\nInteractive authentication required.'
    );
    const exec = jest.fn().mockRejectedValue(err);
    const r = await flushOsDnsCache({ platform: 'linux', exec });
    expect(r.detail).not.toContain('\n');
    expect(r.detail).toContain('Interactive authentication required.');
  });
});

describe('sanitizeDetail', () => {
  it('换行折成分隔符（两个出口：warn 日志按行归属 + 报告 markdown bullet）', () => {
    expect(sanitizeDetail('a\nb')).toBe('a ; b');
    expect(sanitizeDetail('a\n\n  b')).toBe('a ; b');
  });

  it('超长截断到 300 字符并带省略号', () => {
    const out = sanitizeDetail('x'.repeat(500));
    expect(out.length).toBe(301);
    expect(out.endsWith('…')).toBe(true);
  });

  it('短文本原样（不截断、不加省略号）', () => {
    expect(sanitizeDetail('  short  ')).toBe('short');
  });
});

describe('classifyExecFailure — 分类表', () => {
  const cases: Array<[string, unknown, OsDnsFlushFailureReason]> = [
    [
      'ENOENT（PATH 无此命令）',
      Object.assign(new Error('x'), { code: 'ENOENT' }),
      'command-missing',
    ],
    // execFile 不经 shell：PATH 缺失只会走 ENOENT，数字 127 只能是命令自身退出码，对这三个固定命令
    // 而言它不是「命令缺失」。归 unknown 才对——归 command-missing 会给出「结构性不支持、无需重试」的错误指引。
    ['退出码 127（命令自退，非命令缺失）', Object.assign(new Error('x'), { code: 127 }), 'unknown'],
    [
      'EACCES（二进制在但不可执行，无 stderr 无指纹）',
      Object.assign(new Error('spawn resolvectl EACCES'), { code: 'EACCES' }),
      'permission-denied',
    ],
    ['EPERM', Object.assign(new Error('x'), { code: 'EPERM' }), 'permission-denied'],
    [
      '非 Error 但内容含权限指纹（与 catch 侧 String(e) 口径对称）',
      'Permission denied',
      'permission-denied',
    ],
    ['killed（execFile 超时后 kill）', Object.assign(new Error('x'), { killed: true }), 'timeout'],
    [
      'polkit 非交互被拒',
      Object.assign(new Error('x'), { stderr: 'Interactive authentication required.' }),
      'permission-denied',
    ],
    [
      'D-Bus Access denied（大小写不敏感）',
      Object.assign(new Error('x'), { stderr: 'ACCESS DENIED' }),
      'permission-denied',
    ],
    [
      '权限指纹落在 message 而非 stderr',
      new Error('dscacheutil: Operation not permitted'),
      'permission-denied',
    ],
    ['其它非零退出', new Error('exit status 1'), 'unknown'],
    ['null', null, 'unknown'],
    ['undefined', undefined, 'unknown'],
  ];
  // 只用第一个 %s：第二个占位符会把 Error 对象插进用例名并打印堆栈，噪音掩盖真实失败。
  it.each(cases)('%s', (_name, err, expected) => {
    expect(classifyExecFailure(err)).toBe(expected);
  });

  it('ENOENT 优先于权限指纹（命令不存在时 stderr 常混入 permission 字样，误判会给出错误的修复指引）', () => {
    const err = Object.assign(new Error('x'), {
      code: 'ENOENT',
      stderr: 'permission denied',
    });
    expect(classifyExecFailure(err)).toBe('command-missing');
  });
});

describe('shouldFlushOnLinkChange — 链路变化限频（issue #368）', () => {
  const MIN = 60_000;

  it('首次（lastAt=0）恒放行——首次不该被限频吃掉', () => {
    expect(shouldFlushOnLinkChange(0, 1_000, MIN)).toBe(true);
  });

  it('未到间隔 → 拦', () => {
    expect(shouldFlushOnLinkChange(1_000, 1_000 + MIN - 1, MIN)).toBe(false);
  });

  it('恰好等于间隔 → 放行（判据是 >=，差 1ms 被吞会让下次事件再等一整窗口）', () => {
    expect(shouldFlushOnLinkChange(1_000, 1_000 + MIN, MIN)).toBe(true);
  });

  it('超过间隔 → 放行', () => {
    expect(shouldFlushOnLinkChange(1_000, 1_000 + MIN + 1, MIN)).toBe(true);
  });

  it('默认间隔即导出的常量（避免调用方各写一份魔数）', () => {
    expect(shouldFlushOnLinkChange(1_000, 1_000 + LINK_CHANGE_FLUSH_MIN_INTERVAL_MS - 1)).toBe(
      false
    );
    expect(shouldFlushOnLinkChange(1_000, 1_000 + LINK_CHANGE_FLUSH_MIN_INTERVAL_MS)).toBe(true);
  });
});

describe('monotonicNowMs — 单调钟（issue #368 Low-1）', () => {
  it('单调不减：连续两次调用后者不小于前者', () => {
    const a = monotonicNowMs();
    const b = monotonicNowMs();
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it('返回有限的安全整数（毫秒），不是 bigint', () => {
    const v = monotonicNowMs();
    expect(typeof v).toBe('number');
    expect(Number.isFinite(v)).toBe(true);
    expect(Number.isSafeInteger(v)).toBe(true);
  });

  it('不随墙钟改变（Date.now 被 mock 回拨后仍单调）', () => {
    const a = monotonicNowMs();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(0);
    try {
      expect(monotonicNowMs()).toBeGreaterThanOrEqual(a);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('linkChangeFlushRetryDelayMs — 被限频拦下后的补刷延迟（复审 High-1）', () => {
  const MIN = 60_000;

  it('刚刷过 → 补刷排到整个窗口之后', () => {
    expect(linkChangeFlushRetryDelayMs(1_000, 1_000, MIN)).toBe(MIN);
  });

  it('窗口过去一半 → 只等剩下的一半（不是重新等一个完整窗口）', () => {
    expect(linkChangeFlushRetryDelayMs(1_000, 1_000 + MIN / 2, MIN)).toBe(MIN / 2);
  });

  it('窗口已到期/超期 → 0，不产生负延迟', () => {
    expect(linkChangeFlushRetryDelayMs(1_000, 1_000 + MIN, MIN)).toBe(0);
    expect(linkChangeFlushRetryDelayMs(1_000, 1_000 + MIN * 3, MIN)).toBe(0);
  });

  it('与 shouldFlushOnLinkChange 互补：放行时延迟恒为 0，拦下时延迟恒 > 0', () => {
    // 两者若用不同的边界口径，会出现「拦下了但补刷延迟为 0」的忙等或「放行却还排补刷」的重复刷。
    for (const elapsed of [0, 1, MIN / 2, MIN - 1, MIN, MIN + 1]) {
      const now = 1_000 + elapsed;
      const allowed = shouldFlushOnLinkChange(1_000, now, MIN);
      const delay = linkChangeFlushRetryDelayMs(1_000, now, MIN);
      expect(allowed ? delay === 0 : delay > 0).toBe(true);
    }
  });

  it('缺省间隔取 LINK_CHANGE_FLUSH_MIN_INTERVAL_MS', () => {
    expect(linkChangeFlushRetryDelayMs(1_000, 1_000)).toBe(LINK_CHANGE_FLUSH_MIN_INTERVAL_MS);
  });
});

describe('shouldSuppressLinkChangeFlush — link-change 腿的止损（复审 High）', () => {
  it('command-missing 一次即停（结构性不支持，重试零收益）', () => {
    expect(shouldSuppressLinkChangeFlush('command-missing', 1)).toBe(true);
  });

  it.each(['permission-denied', 'timeout', 'unknown'] as const)(
    '%s 在达到连败上限前不抑制（用户可修 / 瞬态会自愈，值得重试）',
    (reason) => {
      expect(shouldSuppressLinkChangeFlush(reason, 1)).toBe(false);
      expect(shouldSuppressLinkChangeFlush(reason, LINK_CHANGE_FLUSH_FAIL_STREAK_LIMIT - 1)).toBe(
        false
      );
    }
  );

  it.each(['permission-denied', 'timeout', 'unknown'] as const)(
    '%s 连败达上限即抑制——否则每个噪音事件都 spawn 一次必失败的命令，会话级永续',
    (reason) => {
      // 典型输入：resolvectl 在但 systemd-resolved 未启用/被 mask（stderr「Failed to connect to bus」→ unknown）。
      expect(shouldSuppressLinkChangeFlush(reason, LINK_CHANGE_FLUSH_FAIL_STREAK_LIMIT)).toBe(true);
    }
  );

  it('reason 缺失（非标准失败）同样受连败上限约束，不留豁免口子', () => {
    expect(shouldSuppressLinkChangeFlush(undefined, 1)).toBe(false);
    expect(shouldSuppressLinkChangeFlush(undefined, LINK_CHANGE_FLUSH_FAIL_STREAK_LIMIT)).toBe(
      true
    );
  });

  it('上限可注入且按 >= 判定（边界不留「差一次」的悬空）', () => {
    expect(shouldSuppressLinkChangeFlush('unknown', 1, 2)).toBe(false);
    expect(shouldSuppressLinkChangeFlush('unknown', 2, 2)).toBe(true);
    expect(shouldSuppressLinkChangeFlush('unknown', 3, 2)).toBe(true);
  });
});
