/**
 * 图标代理协议处理器（Phase 1b §8）：注册 flowz-icon:// scheme，把 renderer 外部图标 <img> 拉取下沉
 * 主进程经 update-in 统一会话——取代删 default session pin 后 manual 接管模式下 <img> 直连破图。viaProxy
 * 时经 update-in→sing-box route→proxyMode 决策，否则 direct 兜底；与四链路同口径。图标 URL 部分来自
 * 用户手动输入（add-custom-app），故复用 ssrf-guard 拦内网（仅实际经代理时豁免 FlowZ FakeIP，同订阅链路）。
 */
import { protocol } from 'electron';
import { ICON_PROXY_SCHEME } from '../shared/icon-proxy';
import { resolveUpdateProxyTarget } from '../shared/update-proxy';
import { safeRedirectFetch, SafeFetchError } from './safe-redirect-fetch';
import { APP_USER_AGENT } from '../shared/constants';
import type { UpdateNetwork } from './services/UpdateNetwork';
import type { UserConfig } from '../shared/types';
import type { LogManager } from './services/LogManager';

/** app ready 前注册 privileged scheme（standard+secure，<img> 可加载该 scheme）。 */
export function registerIconProtocolSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ICON_PROXY_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false },
    },
  ]);
}

export interface IconProtocolDeps {
  updateNetwork: UpdateNetwork;
  proxyRunningProvider: () => boolean;
  updateInPortProvider: () => number | null;
  configProvider: () => Promise<UserConfig>;
  logManager: LogManager;
}

// viaProxy 决策的 config 短 TTL 缓存：图标库网格一次渲染会并发数百个 flowz-icon:// 请求，每请求都
// loadConfig（读盘+校验+sweepStaleTmpFiles）会拖垮主进程。mainSessionViaProxy 变化频率
// 远低于渲染，1s TTL 足够新鲜；proxyRunning / update-in 端口走 thunk（内存、廉价）每次取最新、不缓存。
let cfgMsvpCache: { value: boolean | undefined; expiry: number } | null = null;
const CFG_CACHE_TTL_MS = 1000;

/** app ready 后注册 flowz-icon:// handler（经 update-in 统一会话拉取图标，回退 direct）。 */
export function registerIconProtocol(deps: IconProtocolDeps): void {
  protocol.handle(ICON_PROXY_SCHEME, async (request) => {
    // flowz-icon://i/<encodeURIComponent(realUrl)> → 还原真实图标 URL
    let target: URL;
    try {
      const enc = new URL(request.url).pathname.replace(/^\/+/, '');
      target = new URL(decodeURIComponent(enc));
    } catch {
      return new Response(null, { status: 400 });
    }
    // 放行 http（与改动前 <img src> 直载一致，非回归）：用户自定义图标源可能是 http，明文仅影响图标展示。
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return new Response(null, { status: 400 });
    }

    // viaProxy × update-in 端口（同四链路口径，端口闸共用 resolveUpdateProxyTarget）：代理运行 ∧
    // mainSessionViaProxy 未关 ∧ 端口可用 → 经 update-in。config 经 TTL 缓存避免网格批量渲染逐请求读盘；
    // 端口/运行态走廉价 thunk 每次取最新。
    let viaProxy = false;
    let port = 0;
    try {
      const now = Date.now();
      let msvp: boolean | undefined;
      if (cfgMsvpCache && cfgMsvpCache.expiry > now) {
        msvp = cfgMsvpCache.value;
      } else {
        msvp = (await deps.configProvider()).mainSessionViaProxy;
        cfgMsvpCache = { value: msvp, expiry: now + CFG_CACHE_TTL_MS };
      }
      ({ viaProxy, port } = resolveUpdateProxyTarget(
        deps.proxyRunningProvider(),
        msvp,
        deps.updateInPortProvider()
      ));
    } catch {
      viaProxy = false; // 读 config 失败 → 直连兜底
    }

    // SSRF + 逐跳 redirect 复检收口到 safeRedirectFetch（首跳 + 每跳 Location 过 assertHostAllowed）：图标 URL
    // 部分来自用户手动输入，仅实际经代理（socks，本机内网不可达）时豁免 FlowZ FakeIP。安全拒绝按 reason 映射
    // 状态码（协议非法→400 / SSRF→403 / 超上限→502）；fetchImpl 网络错误冒泡到末端 catch→502。
    try {
      const ses = await deps.updateNetwork.sessionFor(viaProxy, port);
      return await safeRedirectFetch<Response>({
        fetchImpl: (u, init) => ses.fetch(u, init),
        url: target.toString(),
        userAgent: APP_USER_AGENT,
        exemptFakeIp: viaProxy,
      });
    } catch (e) {
      if (e instanceof SafeFetchError) {
        const status = e.reason === 'redirect-protocol' ? 400 : e.reason === 'ssrf' ? 403 : 502;
        return new Response(null, { status });
      }
      deps.logManager.addLog('warn', `图标代理拉取失败: ${e}`, 'IconProtocol');
      return new Response(null, { status: 502 });
    }
  });
}
