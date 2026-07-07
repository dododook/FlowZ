/**
 * 首页状态栏聚合态推导 —— 纯函数，无 react/store 依赖，供 .test.ts 覆盖「出口按连接分态」矩阵。
 * 用户定：连→展示代理出口（proxy IP），未连→展示本地出口（direct IP）；探测层按开关分态，此处只做取值分发。
 */
import type { IpInfo } from '../../../shared/types';
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
}

/**
 * 出口按连接分态：running 时取代理出口（ipInfo.proxy），否则取本地出口（ipInfo.direct）。
 * 缺值返回 null（调用方兜底占位）。
 */
export function pickStatusBarExit(
  running: boolean,
  ipInfo: { direct?: IpInfo | null; proxy?: IpInfo | null } | null | undefined
): StatusBarExit {
  if (running) return { info: ipInfo?.proxy ?? null, isProxy: true };
  return { info: ipInfo?.direct ?? null, isProxy: false };
}
