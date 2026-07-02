/**
 * flushOsDnsCache 单测（node env，依赖全注入）：darwin helper 成功（不降级）/ helper 失败（降级用户级
 * dscacheutil）/ win32 / linux / exec 抛错不外抛——覆盖三平台分支 + 不变量「永不 reject」。
 */
import { flushOsDnsCache } from '../os-dns-flush';

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
    await expect(
      flushOsDnsCache({ platform: 'darwin', exec, helperFlushDns: helper })
    ).resolves.toBeUndefined();
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

  it('exec 抛错（如无 systemd-resolved）→ 永不 reject，仅 warn', async () => {
    const exec = jest.fn().mockRejectedValue(new Error('ENOENT'));
    const log = jest.fn();
    await expect(flushOsDnsCache({ platform: 'linux', exec, log })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('ENOENT'));
  });
});
