/**
 * 图标代理协议处理器（Phase 1b §8）：注册 flowz-icon:// scheme，把 renderer 外部图标 <img> 拉取下沉
 * 主进程经 update-in 统一会话——取代删 default session pin 后 manual 接管模式下 <img> 直连破图。viaProxy
 * 时经 update-in→sing-box route→proxyMode 决策，否则 direct 兜底；与四链路同口径。图标 URL 部分来自
 * 用户手动输入（add-custom-app），故复用 ssrf-guard 拦内网（仅实际经代理时豁免 FlowZ FakeIP，同订阅链路）。
 */
import { protocol } from 'electron';
import { promises as dnsPromises } from 'dns';
import { ICON_PROXY_SCHEME } from '../shared/icon-proxy';
import { assertHostAllowed } from '../shared/ssrf-guard';
import { resolveUpdateProxyTarget } from '../shared/update-proxy';
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
// loadConfig（读盘+校验+sweepStaleTmpFiles）会拖垮主进程（review MEDIUM）。mainSessionViaProxy 变化频率
// 远低于渲染，1s TTL 足够新鲜；proxyRunning / update-in 端口走 thunk（内存、廉价）每次取最新、不缓存。
let cfgMsvpCache: { value: boolean | undefined; expiry: number } | null = null;
const CFG_CACHE_TTL_MS = 1000;

// 图标代理重定向上限（M2）：与订阅链路同口径，redirect:'manual' 自管链、逐跳过 SSRF guard。
const MAX_ICON_REDIRECTS = 5;

/** 释放响应体，避免重定向丢弃上一跳 body 时 socket/内存泄漏。 */
async function drainBody(r: Response): Promise<void> {
  try {
    await r.body?.cancel();
  } catch {
    /* ignore */
  }
}

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

    const lookupFn = (h: string) => dnsPromises.lookup(h, { all: true });
    // SSRF：图标 URL 部分来自用户手动输入 → 拦内网/回环/link-local；仅实际经代理（socks）时豁免 FlowZ
    // FakeIP（系统 DNS 把公网域名解析成假 IP，核按域名 socks5h 重解析、本机内网不可达），直连不豁免。
    try {
      await assertHostAllowed(target, lookupFn, viaProxy); // 首跳 guard
    } catch {
      return new Response(null, { status: 403 });
    }

    // M2：redirect:'manual' 自管重定向链——每跳 Location 重跑 SSRF guard（含 DNS 解析）通过才续跳，最多
    // MAX_ICON_REDIRECTS 跳。默认 follow 会让首跳过 guard 后 30x 到内网不复检（direct 模式下用户自输入 URL
    // 借此 SSRF）。首跳 target 已在上方 guard 过；循环内复检后续每一跳。
    try {
      const ses = await deps.updateNetwork.sessionFor(viaProxy, port);
      let currentUrl = target.toString();
      let response: Response | null = null;
      for (let hop = 0; hop <= MAX_ICON_REDIRECTS; hop++) {
        response = await ses.fetch(currentUrl, {
          headers: { 'User-Agent': APP_USER_AGENT },
          redirect: 'manual',
        });
        const loc =
          response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
        if (!loc) break; // 非 30x（或无 Location）→ 终态响应
        await drainBody(response); // 释放上一跳 body
        if (hop >= MAX_ICON_REDIRECTS) return new Response(null, { status: 502 }); // 超重定向上限
        let nextObj: URL;
        try {
          nextObj = new URL(loc, currentUrl); // 相对 Location 以当前 URL 为基准解析
        } catch {
          return new Response(null, { status: 400 });
        }
        if (nextObj.protocol !== 'https:' && nextObj.protocol !== 'http:') {
          return new Response(null, { status: 400 });
        }
        try {
          await assertHostAllowed(nextObj, lookupFn, viaProxy); // 重定向目标过同一 guard（含 DNS 解析）
        } catch {
          return new Response(null, { status: 403 });
        }
        currentUrl = nextObj.toString();
      }
      return response ?? new Response(null, { status: 502 });
    } catch (e) {
      deps.logManager.addLog('warn', `图标代理拉取失败: ${e}`, 'IconProtocol');
      return new Response(null, { status: 502 });
    }
  });
}
