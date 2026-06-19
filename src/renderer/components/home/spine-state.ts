/**
 * 导流脊（NetworkInfoCard 顶部「你 ── 出口 ── Internet」）的视觉态推导 —— 纯函数，从组件抽出便于
 * 单测覆盖状态矩阵（同 connection-status.ts 模式）。无 react/store 依赖，输入两个布尔、输出视觉档。
 */

/** 脊一段的连通态：idle=灰睡 / flow=绿色活路+流光 / fault=琥珀虚线断点（流光停）。 */
export type SpineState = 'idle' | 'flow' | 'fault';

/** Internet 端点（Globe+文字）的语义色档：muted=睡 / foreground=醒（中性提亮，非染绿）/ warning=降级。 */
export type EndpointTone = 'muted' | 'foreground' | 'warning';

export interface SpineVisual {
  /** 「你的设备」端口圆点：连上中性提亮（muted→foreground），睡时灰。 */
  youDotLit: boolean;
  /** 你 → 出口 段。 */
  leg1: SpineState;
  /** 出口 → Internet 段。 */
  leg2: SpineState;
  /** Internet 端点色档。 */
  internet: EndpointTone;
}

/**
 * 三态视觉：离线（整条灰睡）/ 已连健康（绿活路 + 端点中性提亮）/ 降级（你→出口 green、出口→Internet 琥珀断、
 * Internet 端点琥珀）。配色纪律：绿色专留给流光+出口节点（载流量的主体），端点只做中性提亮不染绿，避免「糊成一片绿」。
 *
 * @param running 代理核心是否在跑（connectionStatus.proxyCore.running）。
 * @param degraded 连上但出口 IP 探测异常（调用方算 running && ipInfo.error && !loading）。未连时无意义——
 *   本函数在 !running 时一律返回 idle，忽略 degraded（离线的 error 是直连探测失败，与代理路径无关）。
 *   注意 ipInfo.error 是「本地出口 ∪ 代理出口」探测的并集（IpInfoService.doRefresh），故 degraded 触发面
 *   ⊇「仅代理出口失败」——这是有意的保守近似：单一 error 标记不分通道，宁可偏保守显降级。
 *
 * 降级时 leg1（你→出口）仍为 flow、仅 leg2 转 fault：核心在跑即隧道已建；末段琥珀（warning，非 destructive）
 * 是「出口可达性存疑/连接质量降级」的保守提示，不强断言外网确定不可达。
 */
export function deriveSpineVisual(running: boolean, degraded: boolean): SpineVisual {
  if (!running) {
    return { youDotLit: false, leg1: 'idle', leg2: 'idle', internet: 'muted' };
  }
  if (degraded) {
    return { youDotLit: true, leg1: 'flow', leg2: 'fault', internet: 'warning' };
  }
  return { youDotLit: true, leg1: 'flow', leg2: 'flow', internet: 'foreground' };
}
