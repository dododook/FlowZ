/**
 * OS 级 DNS 缓存刷新（best-effort）。
 *
 * 动机：核 start/stop 跨越「系统解析器受控/还原」边界时，OS 缓存里可能残留边界另一侧的记录
 * （典型：TUN+FakeIP 会话期缓存的假 IP 停核后仍被命中 → 直连态拿假 IP 撞墙；反向同理）。
 * 由 ProxyManager 在核 start 成功尾部 / stop 尾部 / 链路变化去抖后 fire-and-forget 调用。
 *
 * 不变量：
 *  - 永不 reject（任何失败经**返回值**上报，绝不抛）——刷缓存是增益项，绝不阻塞/拖垮代理生命周期；
 *  - **失败必须可被上层观测**（issue #367）：返回 `OsDnsFlushResult` 携带成败 + 失败分类 + 详情。
 *    历史实现把三种失败（命令缺失 / 权限被拒 / 超时）一律吞成一行 warn，导致「刷新到底有没有发生过」
 *    在产品里无处可查；而它恰好守着「系统解析器缓存了错误记录」这类故障的唯一出口（issue #363）。
 *  - 每个外部命令 3s 硬超时（defaultExec 内置；注入 exec 时超时由注入方按 timeoutMs 参数落实）；helper 路径的
 *    超时由 HelperManager.sendCommand（5s）另行落实，不经本模块的 exec；
 *  - 依赖（exec / platform / helper / log）全部可注入，便于三平台 mock 单测（模块自身零 Electron 依赖）。
 *
 * 平台行为：
 *  - darwin：优先注入的 root helper flush-dns（dscacheutil + killall -HUP mDNSResponder，两层缓存全清）；
 *    helper 不可用/旧 proto（<9 回 ERR unknown）→ 降级用户级 `dscacheutil -flushcache`——无权 HUP
 *    mDNSResponder，对其 unicast cache 无保证、仅尽力。
 *  - win32：`ipconfig /flushdns`（无需提权）。
 *  - linux：`resolvectl flush-caches`（无 systemd-resolved 的发行版命令缺失 → command-missing；
 *    polkit 未放行 `org.freedesktop.resolve1.*` → permission-denied，可经重走 TUN 提权流程修复）。
 *  - 其余平台：no-op（`ok:true` + `skipped:true`，与「刷新成功」区分，避免诊断里把 no-op 读成已生效）。
 */
import { execFile } from 'child_process';

/** 单个外部命令的硬超时：刷缓存命令均为瞬时操作，3s 未归即视为异常（防挂起命令拖住 fire-and-forget 链）。 */
const EXEC_TIMEOUT_MS = 3000;

/**
 * 失败分类（issue #367）。分类的意义不是好看，而是**可操作性不同**：
 *  - `command-missing`：发行版没有该命令（如无 systemd-resolved）→ 本机结构性不支持，无需重试、无需提示用户操作；
 *  - `permission-denied`：命令在但被拒（Linux polkit 未放行 / macOS helper 未授权）→ **可修复**，值得给可操作提示；
 *  - `timeout`：命令挂起（系统 D-Bus 卡死等）→ 瞬态，下次触发可能自愈；
 *  - `unknown`：其余非零退出。
 * 三者混为一谈会让「重走一次提权就能修好」的情况和「这台机器根本没这命令」长得一模一样。
 */
export type OsDnsFlushFailureReason =
  | 'command-missing'
  | 'permission-denied'
  | 'timeout'
  | 'unknown';

/** 刷新结果。`ok:true` 且 `skipped:true` = 平台不支持的 no-op（**不是**刷新成功）。 */
export interface OsDnsFlushResult {
  ok: boolean;
  /** 仅 ok:false 时有值。 */
  reason?: OsDnsFlushFailureReason;
  /** 人类可读详情（成功路径写走了哪条腿；失败路径写原始错误摘要，**已单行化并截断**）。 */
  detail: string;
  /** 平台 no-op（非 darwin/win32/linux）。 */
  skipped?: boolean;
  /**
   * darwin 专有：dscacheutil 成功但 `killall -HUP mDNSResponder` 失败时的原文。
   * 单独成字段而非埋在 detail 里——macOS 的 unicast DNS 缓存主体在 mDNSResponder，HUP 没打成意味着
   * **issue #363 那类负缓存很可能根本没被清掉**。若渲染成与真成功同样的 headline，开发者扫报告时无法区分，
   * 正是本批要消灭的那类误读。
   */
  partial?: string;
}

export interface OsDnsFlushDeps {
  /** 平台判定（默认 process.platform）。 */
  platform?: NodeJS.Platform;
  /** 外部命令执行器（默认 execFile 包装，带 timeoutMs 硬超时；非零退出/超时/spawn 失败 → reject）。
   *  reject 的 Error 上若带 `code` / `killed` / `stderr` 字段，会被 classifyExecFailure 用于失败分类。 */
  exec?: (file: string, args: string[], timeoutMs: number) => Promise<void>;
  /** macOS root helper 的 flush-dns 通道（HelperManager.flushDns）；缺省/null=不可用，直接走用户级降级。
   *  ok:true + partial=helper 应答原文（dscacheutil 成功、仅 HUP mDNSResponder 失败）→ 不降级、warn 留痕。 */
  helperFlushDns?: (() => Promise<{ ok: boolean; partial?: string; error?: string }>) | null;
  /** 日志（默认静默）。 */
  log?: (level: 'info' | 'warn', message: string) => void;
}

/** execFile 失败时 Error 上可能携带的诊断字段（Node 在 err 上挂 code/killed/signal；stderr 由本模块附加）。 */
interface ExecFailure extends Error {
  code?: string | number;
  killed?: boolean;
  stderr?: string;
}

/**
 * 权限被拒的 stderr 指纹。取自各平台实际输出：
 *  - polkit 非交互会话被拒：`Interactive authentication required.`（systemd/resolve1 典型）
 *  - polkit / D-Bus 通用拒绝：`Access denied` / `not authorized`
 *  - POSIX 兜底：`Permission denied` / `Operation not permitted`
 * 大小写不敏感匹配（各发行版本地化前的英文原文大小写不统一）。
 */
const PERMISSION_DENIED_PATTERNS = [
  'interactive authentication required',
  'access denied',
  'not authorized',
  'permission denied',
  'operation not permitted',
];

/**
 * 把 exec 的 reject 归类。判定顺序有意为之：
 *  ① ENOENT/127 = 命令不存在，此时 stderr 里常见 "command not found" 之类，与权限无关，必须先判；
 *  ② killed = execFile 超时后主动 kill 的标记（Node 在 timeout 触发时置 killed:true）；
 *  ③ stderr 指纹 = 权限；
 *  ④ 其余 unknown。
 * 纯函数、导出仅为单测直接覆盖分类表（避免只能经 flushOsDnsCache 间接触发四类失败）。
 */
export function classifyExecFailure(err: unknown): OsDnsFlushFailureReason {
  if (err == null) return 'unknown';
  const e = err instanceof Error ? (err as ExecFailure) : undefined;
  // spawn 失败：ENOENT = PATH 里没有该文件。**不判 127**——execFile 不经 shell，PATH 缺失只会走 ENOENT；
  // 数字 127 只可能是命令自身退出码，对这三个固定命令而言它不是「命令缺失」，误判方向有害
  // （把一个 unknown 失败标成「结构性不支持、无需重试」并给出错误的修复指引）。
  if (e?.code === 'ENOENT') return 'command-missing';
  // 二进制在但不可执行 / 无权 spawn：无 stderr、message 形如 `spawn resolvectl EACCES`，指纹匹配不到，
  // 但它确实是权限问题——漏判会让用户拿不到「重走提权」这条可操作指引。
  if (e?.code === 'EACCES' || e?.code === 'EPERM') return 'permission-denied';
  if (e?.killed === true) return 'timeout';
  // 非 Error 的 reject 也读其内容：catch 侧用 String(e) 组装 detail，此处不读会两边口径不对称。
  const haystack = (e ? `${e.stderr ?? ''}\n${e.message ?? ''}` : String(err)).toLowerCase();
  if (PERMISSION_DENIED_PATTERNS.some((p) => haystack.includes(p))) return 'permission-denied';
  return 'unknown';
}

function defaultExec(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // stderr 必须捕获：失败分类（尤其 permission-denied）唯一的判据来源就是它。历史实现丢弃了 stdio，
    // 于是 polkit 拒绝与任意非零退出在上层完全不可区分。
    // killSignal SIGKILL：默认 SIGTERM 若被命令捕获而不退出，回调永不触发 → promise 永不 settle →
    // lastDnsFlush 永不落库，恰好复现 issue #367 要消灭的「刷新到底发生过没有，无处可查」。
    execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (err, _stdout, stderr) => {
      if (!err) {
        resolve();
        return;
      }
      (err as ExecFailure).stderr = typeof stderr === 'string' ? stderr : String(stderr ?? '');
      reject(err);
    });
  });
}

/**
 * detail 单行化 + 截断（issue #367 Med-1）。
 * execFile 非零退出时 `err.message` 恒为 `Command failed: <cmd>\n<stderr>`——即本批主目标场景
 * （Linux polkit 拒绝）的 detail **必然含换行**。它有两个出口：warn 日志（多行日志被按行切分后归属错乱）
 * 与诊断报告的 markdown bullet（换行后的内容溢出 bullet 成裸段落，且不在任何 fence 内）。
 * 在源头收口一次，两个出口同时受益。300 字符足够容纳任何一条 stderr 首行 + 提示。
 */
export function sanitizeDetail(raw: string): string {
  const oneLine = raw.replace(/\s*\n+\s*/g, ' ; ').trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
}

/** 失败分类 → 可操作提示（无可操作项则不追加）。分类存在的价值全在这里兑现。 */
function actionHint(reason: OsDnsFlushFailureReason, platform: NodeJS.Platform): string {
  if (reason === 'permission-denied') {
    return platform === 'linux'
      ? '（授权规则可能未安装：重新启动一次 TUN 模式会重装 polkit 规则）'
      : '（可尝试重新授权 FlowZ 的系统权限）';
  }
  if (reason === 'command-missing') {
    return platform === 'linux' ? '（本机无 systemd-resolved，属结构性不支持）' : '';
  }
  return '';
}

/**
 * `link-change` 触发的刷新最小间隔（issue #368）。60s 的取法：换网/插坞站是人操作尺度的事件，同一分钟内
 * 再刷一次拿不到新信息；而网络抖动可持续推送事件 burst（Linux `ip monitor` 一次接口变化即十余行），
 * watcher 的 1.5s 去抖只合并单个 burst，不限频等于我们自己对系统解析器发起高频调用。
 * start/stop 不受本限制——那两处跨越「接管/还原」边界，漏刷的代价是陈旧记录留到下一次启停。
 */
export const LINK_CHANGE_FLUSH_MIN_INTERVAL_MS = 60_000;

/**
 * 单调时钟毫秒。限频判定**必须**用它而不是 `Date.now()`：墙钟受 NTP 校正与手动改时间影响，一次回拨会把
 * 抑制窗口拉长到「回拨量 + 间隔」——用户换网后可能几小时刷不上缓存，且没有任何日志异常。
 * `process.hrtime.bigint()` 的起点任意但单调，整除到毫秒后是安全的 number 范围。
 *
 * 注：`lastDnsFlush.at`（诊断侧算 ageSec）仍用墙钟——那是显示用途，回拨的影响只是报告里的年龄偏差，
 * 而换单调钟反而无法与「报告生成时刻」这个墙钟量相减。两处用途不同，各用各的钟是正确的，不是漂移。
 */
export function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * 链路变化触发的刷新是否放行（纯函数，便于覆盖边界）。
 * `lastAtMs=0` 表示本会话尚未因链路变化刷过 → 恒放行（首次不该被限频吃掉）。
 * 判据取 `>=`：恰好等于间隔即放行，避免「差 1ms 被吞掉、下次事件又要等一整个窗口」。
 */
export function shouldFlushOnLinkChange(
  lastAtMs: number,
  nowMs: number,
  minIntervalMs: number = LINK_CHANGE_FLUSH_MIN_INTERVAL_MS
): boolean {
  if (lastAtMs <= 0) return true;
  return nowMs - lastAtMs >= minIntervalMs;
}

/**
 * link-change 腿连续失败多少次后停止尝试。取 3：够给瞬态失败（换网瞬间 resolvectl 暂不可用、D-Bus 慢）
 * 留出重试，又不至于让持续性失败无限刷屏。
 */
export const LINK_CHANGE_FLUSH_FAIL_STREAK_LIMIT = 3;

/**
 * link-change 腿是否应停止尝试（issue #368 复审 High）。
 *
 * 不停会怎样：失败**不推进指纹基线**（这是对的，否则一次失败 = 永久漏刷），于是**下一个纯噪音事件**——
 * RA 刷新 lifetime、DHCP renew、FlowZ 自己的路由操作，正是指纹机制要过滤掉的那些——都会因「基线为空」
 * 再 spawn 一次必然失败的命令并记一条 warn。稳态节奏 = max(限频间隔, 事件间隔)，会话级永续。
 * **这是「把缓存寿命钉在限频间隔上」那个被打回的病灶换了形态**：钉住的东西从刷缓存变成了 spawn + 日志。
 * 典型输入：Linux 上 resolvectl 二进制在、但 systemd-resolved 未启用/被 mask（部分发行版默认、容器、WSL），
 * stderr 形如 `Failed to connect to bus` —— 无 ENOENT、无 killed、不中权限指纹，落 `unknown`。
 *
 * `command-missing` 一次即停（结构性不支持，重试零收益）；其余 reason 给 N 次机会——`permission-denied`
 * 用户可修、瞬态失败会自愈，都值得重试但都不该无限试。停之后**任意一次刷新成功即解除**（start/stop 两点
 * 不受抑制，会话中途装上 systemd-resolved 或修好授权都能恢复）。
 */
export function shouldSuppressLinkChangeFlush(
  reason: OsDnsFlushFailureReason | undefined,
  failStreak: number,
  limit: number = LINK_CHANGE_FLUSH_FAIL_STREAK_LIMIT
): boolean {
  if (reason === 'command-missing') return true;
  return failStreak >= limit;
}

/**
 * 被限频拦下后，距离窗口到期还差多少毫秒（用于排一次补刷，而不是把这次丢掉）。
 *
 * 为什么必须补刷而不是「等下一个事件」：一次 down→up 重连（Wi-Fi 重关联 + DHCP，常见 2–10s）会跨过
 * 1.5s 去抖窗口而产生**两次**触发——断开态那次刷成功、拿到新地址那次落在限频窗口内。若丢弃后者，
 * 被清掉的是断开瞬间的缓存，而**换网完成后写入的污染（打到旧解析器得到的否定应答）一条没清**，
 * 恰好丢掉唯一有用的那次。此后能否自愈取决于「下一个链路事件何时到来」：IPv6 网络上 RA 刷新地址
 * lifetime 是分钟级，IPv4-only + 长租期网络上是 DHCP T1（租期一半，可达小时级），linux/darwin 又没有
 * 轮询腿——即无上界。补刷把它压回「限频间隔」这个确定上界。
 */
export function linkChangeFlushRetryDelayMs(
  lastAtMs: number,
  nowMs: number,
  minIntervalMs: number = LINK_CHANGE_FLUSH_MIN_INTERVAL_MS
): number {
  const remaining = minIntervalMs - (nowMs - lastAtMs);
  return remaining > 0 ? remaining : 0;
}

/** 刷 OS 级 DNS 缓存。语义见文件头：best-effort、永不 reject，成败经返回值上报。 */
export async function flushOsDnsCache(deps: OsDnsFlushDeps = {}): Promise<OsDnsFlushResult> {
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
            const detail = `helper root（dscacheutil 已成功，HUP mDNSResponder 失败）`;
            log('warn', `已刷新系统 DNS 缓存（${detail}）：${sanitizeDetail(r.partial)}`);
            return { ok: true, detail, partial: sanitizeDetail(r.partial) };
          }
          const detail = 'helper root：dscacheutil + HUP mDNSResponder';
          log('info', `已刷新系统 DNS 缓存（${detail}）`);
          return { ok: true, detail };
        }
        log('warn', `helper flush-dns 不可用（${r.error ?? '未知'}），降级用户级 dscacheutil`);
      }
      // 用户级降级：无权 HUP mDNSResponder → 对其 unicast cache 无保证，仅尽力。
      await exec('/usr/bin/dscacheutil', ['-flushcache'], EXEC_TIMEOUT_MS);
      const detail = '用户级 dscacheutil，对 mDNSResponder unicast cache 无保证';
      log('info', `已刷新系统 DNS 缓存（${detail}）`);
      return { ok: true, detail };
    }
    if (platform === 'win32') {
      await exec('ipconfig', ['/flushdns'], EXEC_TIMEOUT_MS);
      const detail = 'ipconfig /flushdns';
      log('info', `已刷新系统 DNS 缓存（${detail}）`);
      return { ok: true, detail };
    }
    if (platform === 'linux') {
      await exec('resolvectl', ['flush-caches'], EXEC_TIMEOUT_MS);
      const detail = 'resolvectl flush-caches';
      log('info', `已刷新系统 DNS 缓存（${detail}）`);
      return { ok: true, detail };
    }
    // 其余平台无对应机制：显式标 skipped，与「刷新成功」区分——否则诊断里 no-op 会被读成「已生效」。
    return { ok: true, skipped: true, detail: `平台 ${platform} 无 DNS 缓存刷新机制，已跳过` };
  } catch (e) {
    // 不变量：永不 reject。失败经返回值上报（issue #367：历史实现在此吞成一行 warn）。
    const reason = classifyExecFailure(e);
    const raw = e instanceof Error ? e.message : String(e);
    // hint **不参与截断**：分类的全部价值就兑现在这一句可操作提示上，把它拼进 raw 再截断，
    // 恰好在 raw 最长（最需要提示）时把提示切掉。只对 raw 收口，hint 追加在外。
    const detail = `${sanitizeDetail(raw)}${actionHint(reason, platform)}`;
    log('warn', `刷新系统 DNS 缓存失败（${reason}）: ${detail}`);
    return { ok: false, reason, detail };
  }
}
