import { session, type Session } from 'electron';
import { resolveUpdateProxyTarget } from '../../shared/update-proxy';
import type { UserConfig } from '../../shared/types';

/**
 * 更新链路统一网络层：资源/应用更新等 main 进程 `net.request` 的会话来源。
 *
 * 取代「裸 net.request 走 default session」——改用独立 partition 会话：
 *  - viaProxy=true → pin 到本机 **socks** 入站。Phase 1 pin mixedPort；Phase 2 改 pin 专用 `update-in`
 *    inbound 动态端口（归属 100% 确定，route 头部钉死按 proxyMode 决策）。net.request 经 socks 不挂死
 *    （Phase 0 V2 实证，docs/design/update-network-unification.md §9）。
 *  - viaProxy=false → 强制 `mode:direct`（绕开 default session 的代理 pin）。
 *
 * 复用 SubscriptionService 的 getDirectSession/getProxiedSession 成熟模式（懒加载 + 端口变化重设——
 * update-in 端口每次核启动重新分配，故必须按端口比对重 pin）。
 * Phase 1b 已删 default session 的 http 入站 pin；renderer 外部图片（图标库/自定义图标/国旗）亦经
 * flowz-icon:// 协议下沉本类 update-in，default session 至此无 FlowZ 外部请求消费者（WarpService 走 node
 * https 自成一路），回归 Electron 默认跟随系统代理。
 */
export class UpdateNetwork {
  private directSession: Session | null = null;
  private proxiedSession: Session | null = null;
  private proxiedPort: number | null = null;

  /** 强制直连会话（绕开 default session 的代理 pin）。 */
  private async getDirectSession(): Promise<Session> {
    if (this.directSession) return this.directSession;
    const s = session.fromPartition('flowz-update-direct');
    await s.setProxy({ mode: 'direct' });
    this.directSession = s;
    return s;
  }

  /** 经代理会话：pin 到本机 socks 入站（update-in 端口）。端口变化重设；loopback 隐式 bypass。 */
  private async getProxiedSession(port: number): Promise<Session> {
    if (this.proxiedSession && this.proxiedPort === port) return this.proxiedSession;
    const s = this.proxiedSession ?? session.fromPartition('flowz-update-proxied');
    await s.setProxy({ proxyRules: `socks5://127.0.0.1:${port}` });
    this.proxiedSession = s;
    this.proxiedPort = port;
    return s;
  }

  /** 按 viaProxy 选会话：true→经 socks 入站（update-in 端口）；false→强制直连。供 net.request 的 `session` 选项使用。 */
  async sessionFor(viaProxy: boolean, port: number): Promise<Session> {
    return viaProxy ? this.getProxiedSession(port) : this.getDirectSession();
  }

  /**
   * sessionFor 的兜底版：经代理会话构造（setProxy/partition 初始化）极罕见 reject 时，回落强制直连会话，
   * **绝不让调用方拿到 undefined**——否则 net.request({session:undefined}) 会落到 Electron default session，
   * 重新引入系统代理污染 / manual 模式挂死，违反「更新链路不消费 default session」。与 CoreDownloader.updateSession
   * 的 direct 兜底同口径。direct 自身再 reject（几乎不可能：setProxy mode:direct）才由调用方最终兜底。
   */
  async sessionForOrDirect(viaProxy: boolean, port: number): Promise<Session> {
    try {
      return await this.sessionFor(viaProxy, port);
    } catch {
      return this.getDirectSession();
    }
  }

  // 类2 收口：主更新链路（应用/资源/核心）viaProxy/port 决策 providers，index.ts 一次注入（共享 proxyManager/
  // configManager）。原 UpdateService/RuleResourceManager/CoreDownloader 三处各自重复「读 config→proxyRunning→
  // updateInPort→viaProxy 求值→端口闸→sessionForOrDirect」易漂移；收口到 resolveSessionForMainUpdate 单点。
  private configProvider: (() => Promise<UserConfig | null>) | null = null;
  private proxyRunningProvider: (() => boolean) | null = null;
  private updateInPortProvider: (() => number | null) | null = null;

  /** index.ts 一次注入主更新链路决策 providers（configManager.loadConfig / proxyManager.running / getUpdateInPort）。 */
  setMainUpdateProviders(deps: {
    configProvider: () => Promise<UserConfig | null>;
    proxyRunningProvider: () => boolean;
    updateInPortProvider: () => number | null;
  }): void {
    this.configProvider = deps.configProvider;
    this.proxyRunningProvider = deps.proxyRunningProvider;
    this.updateInPortProvider = deps.updateInPortProvider;
  }

  /**
   * 主更新链路统一会话决策（类2 收口单点）：读 config(mainSessionViaProxy)+proxyRunning+updateInPort，经
   * resolveUpdateProxyTarget 决定 viaProxy/有效端口（端口闸单一真值，与 icon-protocol 共用）；读 config 失败
   * → 直连兜底；返回 sessionForOrDirect（绝不消费 default session）。UpdateService/RuleResourceManager/
   * CoreDownloader 三处统一调用，防漂移。未注入 providers（理论：index 总注入）→ 读不到则 viaProxy=false。
   */
  async resolveSessionForMainUpdate(): Promise<Session> {
    let target = { viaProxy: false, port: 0 };
    try {
      const cfg = this.configProvider ? await this.configProvider() : null;
      const running = this.proxyRunningProvider ? this.proxyRunningProvider() : false;
      target = resolveUpdateProxyTarget(
        running,
        cfg?.mainSessionViaProxy,
        this.updateInPortProvider?.()
      );
    } catch {
      target = { viaProxy: false, port: 0 }; // 读 config 失败 → 直连兜底
    }
    return this.sessionForOrDirect(target.viaProxy, target.port);
  }
}
