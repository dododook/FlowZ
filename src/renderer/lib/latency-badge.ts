/**
 * 延迟徽标状态机（纯函数，零 react/store 依赖，直接可单测）—— 节点延迟徽标的单一真值。
 *
 * 用户诉求（真机反馈 #4）：TS/组网出口「未登录 / 出口无效」等异常态**直接显示实际状态文案代替假延迟**；
 * 节点状态正常 + 公网连通正常 → 正常显真实延迟（出口伴测已写 latencyMap）。
 *
 * 优先级（结构性不可用压过一切旧值——旧延迟属于上一个有效期，保留显示即误导）：
 *   出口无效(exit-invalid) > 未登录(not-logged-in) > 超时/数值(-1/值) > 不可测(na) > 未测(untested)
 *
 * 数据源边界（见设计 flowz-exit-probe-rtt-latency §9.4）：
 *  - exit-invalid 仅对**选中出口 + running** 有语义（proxyBlocked 由主进程直判，仅选中节点有值）；
 *  - not-logged-in 仅交互式 TS（无 authKey；authKey 形态=静态凭据，等同 WG，不进登录态）；
 *  - 「未授权」(NeedsMachineAuth) 渲染端不可区分（backendState 不入 store）→ 折叠进「未登录」（拍板 P3）；
 *  - 非选中 TS 节点无 per-node 新鲜出口态 → 落 na（诚实边界，不伪造）。
 */
import type { ServerConfig, ProxyExitBlock } from '../../shared/types';
import { isSpeedTestable } from '../../shared/endpoint-routes';

/** 陈旧阈值：会话内超此时长未重测视为旧值 → dim 提示需重测（延迟仅会话内存态，重启清空）。单一真值。 */
export const STALE_MS = 30 * 60 * 1000;

export type LatencyBadge =
  | { kind: 'exit-invalid'; reason: ProxyExitBlock } // 「出口无效」warn；title 可按 reason 细分三原因
  | { kind: 'not-logged-in' } //                       「未登录」warn（含未授权/登录中，折叠）
  | { kind: 'timeout'; stale: boolean } //             latency===-1 →「超时」红
  | { kind: 'value'; latency: number; stale: boolean } // 数值 + 色档
  | { kind: 'na'; reason?: 'ts-needs-core' } //        不可测且无值 → N/A；reason=ts-needs-core：TS-exit 代理关（tooltip「连接代理后可测速」，§16.1）
  | { kind: 'untested'; reason?: 'not-in-pool' }; //   可测无值 →「—」；reason=not-in-pool：订阅新增未入池（tooltip「刷新订阅后纳入测速」，§16.3.3）

export interface LatencyBadgeInput {
  /** 节点配置（protocol / tailscaleSettings.authKey）。 */
  server: ServerConfig;
  /** store.latencyMap[id]：>=0 有效、-1 超时、undefined 未测。 */
  latency: number | undefined;
  /** store.latencyTestedAt[id]（陈旧判定）。 */
  testedAt: number | undefined;
  /** 当前时间（注入可测）。 */
  now: number;
  /** store.tailscaleLoginStates[id]：综合登录态（缓存初值+state 兜底+STATUS 校正三源融合）。 */
  tsLoggedIn: boolean | undefined;
  /** id === config.selectedServerId（proxyBlocked 仅对选中出口有语义）。 */
  isSelectedExit: boolean;
  /** connectionStatus.proxyCore.running。 */
  proxyRunning: boolean;
  /** store.ipInfo?.proxyBlocked（TS 出口 API 直判无效，仅选中节点）。 */
  proxyBlocked: ProxyExitBlock | undefined;
  /** 本会话是否发起过全量测速（store.speedTestAttempted）。未测速前不可测节点与未测节点同显「—」，
   *  点过测速后不可测节点才显「不支持测速」（解释「为什么它没值」）。缺省视作未点过。 */
  speedTestAttempted?: boolean;
  /** id ∈ store.speedTestNotInPool（§16.3.3）：上次测速时非主核池成员而缺席（订阅新增/改址未重启入池）。
   *  可测无值时据此把 tooltip 从泛化「—」换为「刷新订阅后纳入测速」。缺省 false。 */
  notInPool?: boolean;
}

/**
 * 派生徽标态。优先级见文件头。P1>P2 结构上互斥（未登录时 deriveTsExitWarning 恒返 none，proxyBlocked 不可能置起），
 * 顺序仅纵深防御；P2>P3 登录态一失效 latencyMap 残值即过期情报，文案替代（用户反馈原话）；P3>P4 显示开放语义不变。
 */
export function deriveLatencyBadge(i: LatencyBadgeInput): LatencyBadge {
  const isTs = i.server.protocol?.toLowerCase() === 'tailscale';
  // 交互式 TS（无 authKey）：有登录态；authKey 形态=静态凭据，起核即认证，等同 WG，不进登录态（同 deriveTsCardState）。
  const interactiveTs = isTs && !i.server.tailscaleSettings?.authKey?.trim();

  // P1 出口无效（仅 TS 选中出口 + running 有语义）：结构性不可用压过一切——旧值属上一有效期，保留即误导。
  // isTs 前置守卫：proxyBlocked 目前仅 TS 出口置起（结构不变量），显式限定防未来对非 TS 出口置 proxyBlocked 时误标。
  if (isTs && i.isSelectedExit && i.proxyRunning && i.proxyBlocked) {
    return { kind: 'exit-invalid', reason: i.proxyBlocked };
  }
  // P2 未登录（选中与否、代理开关均适用）：无隧道则任何旧延迟必不可信，文案替代假延迟。
  if (interactiveTs && i.tsLoggedIn !== true) {
    return { kind: 'not-logged-in' };
  }
  // P3 有值显值（伴测/测速同管道；-1 仅测速入口产生，伴测绝不写 -1）。
  const stale = i.testedAt !== undefined && i.now - i.testedAt > STALE_MS;
  if (i.latency === -1) return { kind: 'timeout', stale };
  if (i.latency !== undefined) return { kind: 'value', latency: i.latency, stale };
  // P4 诚实边界：不可测且无值。**点过全量测速才显「不支持测速」**（解释「为什么它没值」）；未点过则与未测同显
  //「—」（untested，口径同步——用户诉求：不支持测速应仅在点击测速后显示，否则逻辑不同步）。
  // §16.1 path-aware：TS-exit 仅主核池可用（proxyRunning）时可测——代理关时落此 na 分支。
  if (!isSpeedTestable(i.server, { mainCorePool: i.proxyRunning })) {
    if (!i.speedTestAttempted) return { kind: 'untested' };
    // 「主核池可用即可测」但当前不可测 = 只是缺主核（TS-exit 代理关）→ reason 引导连代理；否则恒不可测（reverseMesh/
    // custom-endpoint/无 exitNode TS）→ 平凡 na「不支持测速」。
    const needsCore = isSpeedTestable(i.server, { mainCorePool: true });
    return needsCore ? { kind: 'na', reason: 'ts-needs-core' } : { kind: 'na' };
  }
  // 可测无值：§16.3.3 not-in-pool（订阅新增/改址未重启入池）→ reason 供 tooltip 引导刷新；否则纯未测「—」。
  return i.notInPool ? { kind: 'untested', reason: 'not-in-pool' } : { kind: 'untested' };
}
