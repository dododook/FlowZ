/**
 * 出口伴测 runner —— 代理出口探测成功后经主核 probe-proxy-in 测「当前出口」的 warm TTFB（口径 == 节点测速值），
 * 写回 latencyMap[当前出口节点 id]，使 IP 类 / TS / 组网出口的「实际延迟」跟随出口探测更新。
 *
 * 为何链外 fire-and-forget（不进 IpInfoService.enqueue 串行链）：一次伴测最长 MEASURE_TIMEOUT_MS(8s)，串在刷新链里
 * 会把「切节点→新 IP 显示」拖慢至多 8s。改为链外单飞 + 双点守卫：切节点时在途伴测隧道被精准断连杀掉→返 null→不写，
 * 竞态自愈。纯依赖注入（deps 全部 call-time 取值），无 electron/store 依赖 → 可单测；任何异常静默（绝不污染探测链）。
 */

/** 当前应写入延迟的出口（五重守卫全过才返值；任一不满足→null→本轮不测/不写）。见设计 §2.4 守卫矩阵。 */
export interface ExitProbeTarget {
  /** 当前实际出口节点 id（写 latencyMap 的键）。 */
  serverId: string;
  /** 主核 probe-proxy-in 的 HTTP 代理端口（CONNECT 伴测入口）。 */
  probeProxyPort: number;
}

export interface ExitProbeLatencyDeps {
  /** 守卫判定（running + 有实际出口节点 + 非全局直连 + 登录让位未生效 + TS gate 未命中 + 探针端口就绪）；任一不过→null。 */
  getSelectedExit: () => ExitProbeTarget | null;
  /** 经 probe-proxy-in 测 warm TTFB（== 节点测速口径）；失败/超时/非 2xx/对端过早关闭 → null。 */
  measureWarmRtt: (probeProxyPort: number) => Promise<number | null>;
  /** 发布延迟：广播 EVENT_SPEED_TEST_RESULT + 合并入托盘（keepTestingState，不复位在飞测速态）。 */
  publish: (serverId: string, latency: number) => void;
  /** 调试日志（可选）。 */
  log?: (message: string) => void;
}

export interface ExitProbeLatencyOptions {
  /** 每节点最小伴测间隔（被动触发生效；手动重探 bypass）。默认 30s。 */
  minIntervalMs?: number;
  /** 取当前时间（单测注入定桩控制节流窗口）。默认 Date.now。 */
  now?: () => number;
}

/**
 * 造「代理出口探测成功」回调，交给 IpInfoService 作 onProxyProbeSuccess 注入。
 *  - 单飞：在飞期间的并发探测成功直接返回（一次只跑一个伴测）。
 *  - 节流：非手动触发 minIntervalMs/节点内跳过；手动重探（ctx.manual）bypass（用户要新鲜值）。仅【成功写入】推进 lastAt
 *    → 失败不占节流额度、下次探测成功可立即重试。
 *  - 双点守卫：测量前后各取一次 getSelectedExit，serverId 不一致→丢弃（测量 8s 窗口内热切换→不写错节点）。
 *  - 失败不写：measureWarmRtt 返 null→放弃（绝不写 -1，保留旧值）。
 */
export function createExitProbeLatencyRunner(
  deps: ExitProbeLatencyDeps,
  options: ExitProbeLatencyOptions = {}
): (ctx: { manual: boolean }) => Promise<void> {
  const minIntervalMs = options.minIntervalMs ?? 30_000;
  const now = options.now ?? Date.now;
  let inFlight = false;
  let pendingCtx: { manual: boolean } | null = null; // Y2：在飞期被吞的最新触发（settle 后补跑一次）
  const lastAt = new Map<string, number>();

  return async function onProxyProbeSuccess(ctx: { manual: boolean }): Promise<void> {
    if (inFlight) {
      // Y2（§12.3.2 / P8-GAP④）：在飞期间的新触发不再丢弃，记录最新一次（manual OR 合并），本轮 settle 后补跑一次。
      // 治「快切到新出口时其唯一 probe-success 撞上上一节点在飞测量 → 被吞后无补测事件（事件驱动、无轮询）→ 恒无值」。
      pendingCtx = { manual: (pendingCtx?.manual ?? false) || ctx.manual };
      return;
    }
    // 全程包 try/catch：守卫①/节流（getSelectedExit/now）理论上也可能抛，异常一律静默不外泄（模块头注承诺；
    // 接线处 `void runner(ctx)` 无 .catch，未包会成 unhandledRejection）。inFlight 由内层 try/finally 管——
    // 置真前抛出则从未置真、无需复位。
    try {
      const exit = deps.getSelectedExit(); // 守卫①（测量前）
      if (!exit) return;
      if (!ctx.manual && now() - (lastAt.get(exit.serverId) ?? 0) < minIntervalMs) return; // 节流（手动 bypass）
      inFlight = true;
      try {
        const rtt = await deps.measureWarmRtt(exit.probeProxyPort); // ≤8s，失败 null
        if (rtt === null) {
          deps.log?.(`exit-probe latency miss -> ${exit.serverId}`); // Y1：失败带 serverId（配 SpeedTest 侧 reason+target）
          return; // 失败不写、不写 -1、保留旧值
        }
        const after = deps.getSelectedExit(); // 守卫②（测量后）：双点捕获
        if (!after || after.serverId !== exit.serverId) return; // 测量期间切走 → 丢弃
        deps.publish(exit.serverId, rtt);
        lastAt.set(exit.serverId, now()); // publish 成功后才推进节流额度（失败/抛异常不占额度）
        deps.log?.(`exit-probe latency ${rtt}ms -> ${exit.serverId}`);
      } finally {
        inFlight = false;
      }
    } catch (e) {
      // 伴测属增益路径，任何异常（守卫①/节流/measure/publish）静默，不污染探测链、不成 unhandledRejection。
      deps.log?.(`exit-probe latency error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // Y2：本轮 settle 后若在飞期有被吞的触发 → 取出置空、补跑一次（走完整守卫链重入；每次 settle 至多一次、
      // 仍纯事件驱动无定时器 → 无新增风暴面）。早退分支 inFlight 恒 false 且 pendingCtx 恒 null（未进在飞窗口无人记录）
      // → 天然 no-op；void 触发不叠调用栈（新 async 兄弟调用，非嵌套）。
      if (!inFlight && pendingCtx) {
        const next = pendingCtx;
        pendingCtx = null;
        void onProxyProbeSuccess(next);
      }
    }
  };
}
