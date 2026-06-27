/**
 * 提权 helper 跨平台公共接口。
 *
 * 把 macOS 的 HelperManager 与（后续）Windows 的 WindowsServiceHelper 收敛到同一接口，
 * ProxyManager / helper-handlers 只依赖本接口，按 process.platform 在 index.ts 装配对应实现。
 * 各实现自行处理「不支持平台安全降级」，互不进入对方分支 → 跨平台零回归。
 *
 * 仅含 ProxyManager / helper-handlers 实际调用的方法子集；macOS 专属的 installCore（CoreUpdateService
 * v5 持久化内核更新）刻意不入接口，由 CoreUpdateService 直接依赖具体 HelperManager。
 *
 * 字段语义（如 HelperStatus 的 backgroundDisabled/pathMismatch）是 macOS 专属，Windows 实现取子集、
 * 其余恒默认值；消费方契约见 HelperStatus 字段注释。
 */
import type { HelperStatus } from '../../shared/types';

/** 经 helper 以特权启动 sing-box 的结果（跨平台公共，IPrivilegedHelper.startCore 返回类型）。
 * 提取到本接口文件：消除 WindowsServiceHelper 反向依赖 macOS HelperManager（仅类型耦合）。 */
export interface HelperStartResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

export interface IPrivilegedHelper {
  /** 能否零提权驱动 TUN（已装 + 就绪 + ping 通）。ProxyManager 启动路由用。 */
  isReady(): Promise<boolean>;
  /** 完整状态：供设置页展示 + 安装/卸载按钮判态。force=窗口聚焦时强制 fresh。 */
  getStatus(force?: boolean): Promise<HelperStatus>;
  /** 经 helper 以特权启动 sing-box（零提权）。 */
  startCore(configPath: string, logPath: string, forward: boolean): Promise<HelperStartResult>;
  /** 经 helper 停止 sing-box（零提权）。 */
  stopCore(): Promise<boolean>;
  /** 经 helper 杀掉所有 sing-box（含孤儿），零提权。 */
  cleanup(): Promise<boolean>;
  /** 经 helper 按端口清占用者：是 sing-box 才杀，否则回报 foreign（不杀无辜）。 */
  freePort(port: number): Promise<{ freed?: boolean; foreign?: string; error?: string }>;
  /** helper 当前是否在托管一个 sing-box（孤儿探测）。 */
  coreStatus(): Promise<{ running: boolean; pid?: number }>;
  /** 安装/修复 helper（弹一次系统授权）。 */
  install(): Promise<{ success: boolean; error?: string; status: HelperStatus }>;
  /** 卸载 helper（弹一次系统授权）。 */
  uninstall(): Promise<{ success: boolean; error?: string; status: HelperStatus }>;
  /** 在指定内核接口装/删受约束路由（出口托管：System 接口拆半默认路由）。proto<7 旧 helper → {ok:false}。 */
  routeAdd(iface: string, cidrs: string[]): Promise<{ ok: boolean; error?: string }>;
  routeDel(iface: string, cidrs: string[]): Promise<{ ok: boolean; error?: string }>;
  /** macOS 安全网：补回被 sing-tun setRoutes EEXIST 善后误删的 en0 全局默认路由（停核后断网）。proto<8 旧 helper →
   *  {ok:false}。Windows 实现为 no-op（该误删 bug 仅 macOS）。 */
  restoreDefaultRoute(gateway: string): Promise<{ ok: boolean; error?: string }>;
}
