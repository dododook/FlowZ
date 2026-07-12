/**
 * 首页状态栏聚合态推导 —— 纯函数，无 react/store 依赖，供 .test.ts 覆盖「出口按连接分态」矩阵。
 * 用户定：连→展示代理出口（proxy IP），未连→展示本地出口（direct IP）；探测层按开关分态，此处只做取值分发。
 */
import type { IpInfo, ProxyExitBlock } from '../../../shared/types';
import type { StatusInfo } from './connection-status';

/** 状态点色档：与 Badge variant 对齐（default=已连绿 / secondary=进行中琥珀 / destructive=错误红 / outline=未连灰）。 */
export type StatusDotTone = 'ok' | 'warn' | 'err' | 'idle';

export function statusDotTone(variant: StatusInfo['variant']): StatusDotTone {
  switch (variant) {
    case 'default':
      return 'ok';
    case 'secondary':
      return 'warn';
    case 'destructive':
      return 'err';
    default:
      return 'idle';
  }
}

export interface StatusBarExit {
  /** 出口 IP 快照（running→proxy、否则→direct）；无值为 null。 */
  info: IpInfo | null;
  /** 该出口是否为代理出口（true=proxy、false=本地直连出口）。 */
  isProxy: boolean;
  /** TS 出口 API 直判无效（proxyBlocked：选中 TS 出口未广告出口设备 / exit peer 离线）→ 未探测的终态：状态栏显
   *  「出口无效」橘色警示。仅 running 时有意义，优先级高于 detecting/failed（已直判无效即抢占，不再显「检测中/超时」）。 */
  invalid: boolean;
  /** 探测进行中（loading，尚无结果）：状态栏显「检测中…」。 */
  detecting: boolean;
  /** 探测已完成但无出口 IP（超时/广播失效/路由无效，如 TS 选中出口探测超时）：状态栏显「检测超时」橘色警示（用户反馈）。 */
  failed: boolean;
}

/**
 * 出口按连接分态：running 时取代理出口（ipInfo.proxy），否则取本地出口（ipInfo.direct）。缺值返回 null。
 * 无 info 时的三态优先级 invalid > detecting > failed：
 *  - invalid：running + proxyBlocked（TS 出口 API 直判无效、根本没探）→「出口无效」，抢占——detecting/failed 暗示
 *    「还在探/探失败」，与「已直判无效不探」矛盾，故 invalid 为真时二者恒 false；
 *  - detecting：loading 中，**或启动相位 connecting 内**（见下）→「检测中…」；
 *  - failed：已探测过（updatedAt>0）非 loading 仍无 IP →「检测超时」（含 TS 出口广播失效/路由无效）。
 *
 * connecting（=proxyPhase==='starting'，按钮转圈）：启动瞬间 running 已翻真、但主进程 markProxyConnecting 的
 * loading 快照尚未抵达渲染端的空窗里，旧 updatedAt 会让无 proxy IP 误判 failed → 闪「检测超时」。故启动相位内
 * 强制归 detecting、压掉 failed —— 实际探测已就绪门控（markProxyConnecting/refreshProxyPostConnect 宽退避重试），
 * 此空窗不是真超时，只是显示层错判。invalid 仍最高优先（真直判无效即便启动中也照显「出口无效」）。
 */
export function pickStatusBarExit(
  running: boolean,
  ipInfo:
    | {
        direct?: IpInfo | null;
        proxy?: IpInfo | null;
        loading?: boolean;
        updatedAt?: number;
        proxyBlocked?: ProxyExitBlock;
      }
    | null
    | undefined,
  connecting = false
): StatusBarExit {
  const info = (running ? ipInfo?.proxy : ipInfo?.direct) ?? null;
  // invalid 抢占：running + 直判无效 + 无 info。detecting/failed 在 invalid 为真时一律 false。
  const invalid = !info && running && !!ipInfo?.proxyBlocked;
  const detecting = !info && !invalid && (!!ipInfo?.loading || connecting);
  const failed = !info && !invalid && !detecting && !!ipInfo?.updatedAt;
  return { info, isProxy: running, invalid, detecting, failed };
}
