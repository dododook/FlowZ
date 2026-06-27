import { session, type Session } from 'electron';

/**
 * 更新链路统一网络层：资源/应用更新等 main 进程 `net.request` 的会话来源。
 *
 * 取代「裸 net.request 走 default session + index.ts applyMainSessionProxy pin 到 http 入站」——
 * 改用独立 partition 会话：
 *  - viaProxy=true → pin 到本机 **socks** 入站。Phase 1 pin mixedPort；Phase 2 改 pin 专用 `update-in`
 *    inbound 动态端口（归属 100% 确定，route 头部钉死按 proxyMode 决策）。net.request 经 socks 不挂死
 *    （Phase 0 V2 实证，docs/design/update-network-unification.md §9）。
 *  - viaProxy=false → 强制 `mode:direct`（绕开 default session 的代理 pin）。
 *
 * 复用 SubscriptionService 的 getDirectSession/getProxiedSession 成熟模式（懒加载 + 端口变化重设——
 * update-in 端口每次核启动重新分配，故必须按端口比对重 pin）。
 * Phase 1 暂保留 default session 的 pin（applyMainSessionProxy 不动）；删除待 Phase 1b 的 default session
 * 完整消费面分析（renderer webContents session 等）。
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
}
