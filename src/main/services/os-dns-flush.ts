/**
 * OS 级 DNS 缓存刷新（best-effort）。
 *
 * 动机：核 start/stop 跨越「系统解析器受控/还原」边界时，OS 缓存里可能残留边界另一侧的记录
 * （典型：TUN+FakeIP 会话期缓存的假 IP 停核后仍被命中 → 直连态拿假 IP 撞墙；反向同理）。
 * 由 ProxyManager 在核 start 成功尾部 / stop 尾部 fire-and-forget 调用。
 *
 * 不变量：
 *  - 永不 reject（任何失败仅 log warn）——刷缓存是增益项，绝不阻塞/拖垮代理生命周期；
 *  - 每个外部命令 3s 硬超时（defaultExec 内置；注入 exec 时超时由注入方按 timeoutMs 参数落实）；helper 路径的
 *    超时由 HelperManager.sendCommand（5s）另行落实，不经本模块的 exec；
 *  - 依赖（exec / platform / helper / log）全部可注入，便于三平台 mock 单测（模块自身零 Electron 依赖）。
 *
 * 平台行为：
 *  - darwin：优先注入的 root helper flush-dns（dscacheutil + killall -HUP mDNSResponder，两层缓存全清）；
 *    helper 不可用/旧 proto（<9 回 ERR unknown）→ 降级用户级 `dscacheutil -flushcache`——无权 HUP
 *    mDNSResponder，对其 unicast cache 无保证、仅尽力。
 *  - win32：`ipconfig /flushdns`（无需提权）。
 *  - linux：`resolvectl flush-caches`（无 systemd-resolved 的发行版命令缺失/失败 → 仅日志）。
 *  - 其余平台：no-op。
 */
import { execFile } from 'child_process';

/** 单个外部命令的硬超时：刷缓存命令均为瞬时操作，3s 未归即视为异常（防挂起命令拖住 fire-and-forget 链）。 */
const EXEC_TIMEOUT_MS = 3000;

export interface OsDnsFlushDeps {
  /** 平台判定（默认 process.platform）。 */
  platform?: NodeJS.Platform;
  /** 外部命令执行器（默认 execFile 包装，带 timeoutMs 硬超时；非零退出/超时/spawn 失败 → reject）。 */
  exec?: (file: string, args: string[], timeoutMs: number) => Promise<void>;
  /** macOS root helper 的 flush-dns 通道（HelperManager.flushDns）；缺省/null=不可用，直接走用户级降级。
   *  ok:true + partial=helper 应答原文（dscacheutil 成功、仅 HUP mDNSResponder 失败）→ 不降级、warn 留痕。 */
  helperFlushDns?: (() => Promise<{ ok: boolean; partial?: string; error?: string }>) | null;
  /** 日志（默认静默）。 */
  log?: (level: 'info' | 'warn', message: string) => void;
}

function defaultExec(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (err) => (err ? reject(err) : resolve()));
  });
}

/** 刷 OS 级 DNS 缓存。语义见文件头：best-effort、永不 reject。 */
export async function flushOsDnsCache(deps: OsDnsFlushDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? defaultExec;
  const log = deps.log ?? ((): void => {});
  try {
    if (platform === 'darwin') {
      if (deps.helperFlushDns) {
        // helper 契约上永不 reject（HelperManager.flushDns 异常收敛为 ok:false）；.catch 兜实现漂移，保证降级腿可达。
        const r = await deps
          .helperFlushDns()
          .catch((e): { ok: boolean; partial?: string; error?: string } => ({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          }));
        if (r.ok) {
          if (r.partial) {
            // partial：dscacheutil 已成功、仅 HUP mDNSResponder 失败——不降级（用户级同样无权 HUP，重复无益），
            // 降格 warn 留痕便于诊断。
            log('warn', `已刷新系统 DNS 缓存（helper root，partial：${r.partial}）`);
          } else {
            log('info', '已刷新系统 DNS 缓存（helper root：dscacheutil + HUP mDNSResponder）');
          }
          return;
        }
        log('warn', `helper flush-dns 不可用（${r.error ?? '未知'}），降级用户级 dscacheutil`);
      }
      // 用户级降级：无权 HUP mDNSResponder → 对其 unicast cache 无保证，仅尽力。
      await exec('/usr/bin/dscacheutil', ['-flushcache'], EXEC_TIMEOUT_MS);
      log(
        'info',
        '已刷新系统 DNS 缓存（用户级 dscacheutil，对 mDNSResponder unicast cache 无保证）'
      );
    } else if (platform === 'win32') {
      await exec('ipconfig', ['/flushdns'], EXEC_TIMEOUT_MS);
      log('info', '已刷新系统 DNS 缓存（ipconfig /flushdns）');
    } else if (platform === 'linux') {
      await exec('resolvectl', ['flush-caches'], EXEC_TIMEOUT_MS);
      log('info', '已刷新系统 DNS 缓存（resolvectl flush-caches）');
    }
  } catch (e) {
    // 不变量：永不 reject。命令缺失（如无 systemd-resolved）/超时/非零退出 → 仅记 warn。
    log('warn', `刷新系统 DNS 缓存失败（忽略）: ${e instanceof Error ? e.message : String(e)}`);
  }
}
