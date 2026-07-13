/**
 * 解锁 checker ×6 —— 纯逻辑，fetch 注入（天然可单测、无网络）。
 *
 * 判定法逐服务对齐 lmc999/RegionRestrictionCheck 主脚本 check.sh（enum：ok/partial/blocked/timeout）：
 *  - 端点 / marker / titleId / apiKey / 正则全在 `unlock-endpoints.ts`，本文件只有判定逻辑（漂移不改这里）。
 *  - 网络失败 / 无响应 / 无法判定 → `timeout`（统一兜底，不误 block；见 flowz-unlock-detection.md §4）。
 */

import type { ServiceId, UnlockResult } from '../../../shared/unlock-detection';
import { parseTrace } from '../IpInfoService';
import type { UnlockFetch, UnlockResponse } from './unlock-http';
import { CHATGPT, CLAUDE, DISNEY, GEMINI, NETFLIX, SPOTIFY, UA } from './unlock-endpoints';

/** 签名统一：注入 fetch，返回结果（不抛，异常由编排器兜 timeout）。 */
export type Checker = (fetch: UnlockFetch) => Promise<UnlockResult>;

const HDRS = { 'User-Agent': UA };
/** Netflix：UA + accept-language（对齐 check.sh；不带其 baked 过期 cookie）。 */
const NETFLIX_HDRS = { 'User-Agent': UA, 'accept-language': 'en-US,en;q=0.9' };

/** 拿到响应（status>0 且无传输错）才算「可达」；status:0/error = 网络失败。 */
const reachable = (r: UnlockResponse): boolean => r.status > 0 && !r.error;
/** 大小写不敏感子串匹配（对齐 check.sh 用 `grep -i` 的 marker：ChatGPT VPN/unsupported_country、Disney 403 ERROR/forbidden-location）。 */
const hasCI = (body: string, marker: string): boolean =>
  body.toLowerCase().includes(marker.toLowerCase());
/** 打服务自有 trace 取地区码（失败返 undefined，不影响判定，仅作展示 region）。 */
async function traceRegion(fetch: UnlockFetch, url: string): Promise<string | undefined> {
  const r = await fetch({ url, headers: HDRS });
  if (r.status !== 200 || !r.body) return undefined;
  return parseTrace(r.body)?.countryCode;
}

/**
 * ChatGPT（对齐 check.sh WebTest_OpenAI）：r1=cookie_requirements 查 unsupported_country、r2=ios 首页查 VPN。
 * 任一网络失败→timeout；两净→ok；两脏→blocked；一净一脏→partial（r1净r2脏=web-only / r1脏r2净=mobile-only）。
 * region 取 trace(loc)（仅展示，可缺）。
 */
export const checkChatgpt: Checker = async (fetch) => {
  const [trace, cookie, ios] = await Promise.all([
    fetch({ url: CHATGPT.traceUrl, headers: HDRS }),
    fetch({ url: CHATGPT.cookieUrl, headers: HDRS }),
    fetch({ url: CHATGPT.iosUrl, headers: HDRS }),
  ]);
  if (!reachable(cookie) || !reachable(ios)) return { status: 'timeout' }; // 任一端点不可达
  const region = trace.status === 200 ? parseTrace(trace.body)?.countryCode : undefined;

  const cookieDirty = hasCI(cookie.body, CHATGPT.cookieBlockMarker);
  const iosDirty = hasCI(ios.body, CHATGPT.iosBlockMarker);
  if (!cookieDirty && !iosDirty) return { status: 'ok', region }; // 两净
  if (cookieDirty && iosDirty) return { status: 'blocked', region }; // 两脏
  return { status: 'partial', region }; // 一净一脏（web-only / mobile-only）
};

/**
 * Claude（判定基线 check.sh WebTest_Claude，按真机 net.request 实况放宽到「域」）：跟随 claude.ai/ 跳转取最终 URL。
 * 实测（真 Chromium net.request，非 curl）：登出用户 claude.ai/ 会 302 到 claude.ai/login（本区可用的正常行为）；
 * 地区封禁则跳去 www.anthropic.com/app-unavailable-in-region。故：
 *  - 无响应→timeout；含 `app-unavailable-in-region`→blocked；最终落在 **claude.ai 任意路径**（/、/login、/new，含 403
 *    challenge 停 claude.ai/）→ok（本区可用）；被引到其它未知域→timeout（不误 block）。
 * （check.sh 只认精确 https://claude.ai/ 是因其 curl UA 触发 CF 403 停在 claude.ai/；真 Chromium 过盾跟到 /login，故放宽到域。）
 * region 取 trace（仅展示，可缺）。
 */
export const checkClaude: Checker = async (fetch) => {
  const [res, region] = await Promise.all([
    fetch({ url: CLAUDE.homeUrl, headers: HDRS }),
    traceRegion(fetch, CLAUDE.traceUrl),
  ]);
  if (!reachable(res)) return { status: 'timeout', region }; // 无响应 ≠ 封禁
  const chain = res.redirectChain;
  const last = chain.length ? chain[chain.length - 1].location : CLAUDE.homeUrl;
  const finalUrl = last.split('?')[0].split('#')[0];
  if (finalUrl.includes(CLAUDE.blockMarker)) return { status: 'blocked', region }; // 地区不可用页（优先，含跳 claude.ai 域内该路径）
  let host = '';
  try {
    host = new URL(finalUrl).hostname;
  } catch {
    /* 非法 URL → 落 timeout */
  }
  if (host === 'claude.ai') return { status: 'ok', region }; // 落 claude.ai 任意路径（/login /new /403challenge）= 本区可用
  return { status: 'timeout', region }; // 被引到其它未知域 → 不误 block
};

/**
 * Gemini（对齐 check.sh WebTest_Gemini）：GET gemini.google.com/ 跟随跳转。网络失败→timeout；
 * 可用性 marker 命中→ok，缺失→blocked。region：,2,1,200,"XXX" 提 3 字母码（仅展示，可缺）。
 */
export const checkGemini: Checker = async (fetch) => {
  const res = await fetch({ url: GEMINI.homeUrl, headers: HDRS });
  if (!reachable(res)) return { status: 'timeout' };
  const region = GEMINI.regionRe.exec(res.body)?.[1];
  if (res.body.includes(GEMINI.availableMarker)) return { status: 'ok', region };
  return { status: 'blocked', region };
};

/**
 * 从 Netflix 本地化路径首段取 region（无前缀=US）。兼容 `/{region}-{lang}/`（如 `/hk-en/`）与 bare
 * `/{region}/`（如 `/jp/`）。排除已知非地区 2 字母段（如 `en` 语言码——help.netflix.com 会裸跳 `/en`，
 * 那是语言不是国家，误判会污染 region）。
 */
const NETFLIX_NON_REGION_SEGMENTS = new Set<string>(['en']);
function netflixRegion(res: UnlockResponse): string | undefined {
  for (const hop of res.redirectChain) {
    try {
      const seg = new URL(hop.location).pathname.split('/').filter(Boolean)[0] ?? '';
      const m = /^([a-z]{2})(-[a-z]{2,4})?$/.exec(seg);
      if (m && !NETFLIX_NON_REGION_SEGMENTS.has(m[1])) return m[1].toUpperCase();
    } catch {
      /* 非法 URL 跳过 */
    }
  }
  return undefined;
}

/**
 * Netflix（对齐 check.sh MediaUnlockTest_Netflix）：两非自制 title（81280792 + 70143836），UA+accept-language。
 * 任一网络失败→timeout；两个 body 都含 `Oh no!`（非自制均不可看）→partial（仅自制剧）；任一不含（可看）→ok。
 * region（仅展示）：body countryName 前的 "id" 值，缺则重定向本地化前缀兜底（无=US）。
 */
export const checkNetflix: Checker = async (fetch) => {
  const [r1, r2] = await Promise.all([
    fetch({ url: NETFLIX.nonOriginalUrl, headers: NETFLIX_HDRS }),
    fetch({ url: NETFLIX.nonOriginalUrl2, headers: NETFLIX_HDRS }),
  ]);
  if (!reachable(r1) || !reachable(r2)) return { status: 'timeout' }; // 任一不可达
  // Netflix **未在本国提供业务**（大陆 CN 等）：HTTP 403 + "Not Available"（无 per-title 的 "Oh no!"）→ blocked。
  // 必须先于 ok 兜底判——否则「可达(403>0)+无 Oh no!」落 else 被误判完整解锁（大陆阿里云实测误判根因）。两非自制皆
  // 命中「未提供」信号 = 国家级不可用（非单片限制）；合法解锁区对这两片只返 200 或 "Oh no!"(404)，绝不返 403，故 403
  // 是可靠国家级信号。
  const notAvailable = (r: UnlockResponse): boolean =>
    r.status === 403 || hasCI(r.body, NETFLIX.notAvailableMarker);
  if (notAvailable(r1) && notAvailable(r2)) return { status: 'blocked' }; // Netflix 未进本国
  const region =
    NETFLIX.regionRe.exec(r1.body)?.[1] ??
    netflixRegion(r1) ??
    (r1.status === 200 ? 'US' : undefined);
  const d1 = r1.body.includes(NETFLIX.ohNoMarker);
  const d2 = r2.body.includes(NETFLIX.ohNoMarker);
  if (d1 && d2) return { status: 'partial', region }; // 两非自制皆不可看 → 仅自制剧
  return { status: 'ok', region }; // 任一可看 → 完整解锁
};

/**
 * Disney+（对齐 check.sh MediaUnlockTest_DisneyPlus）：bamgrid devices→token→graphql，末段打 disneyplus.com 判 preview。
 *  devices 网络失败→timeout；devices/token body `403 ERROR`→blocked；token `forbidden-location`→blocked；
 *  无 assertion / refresh_token→timeout；graphql 取 countryCode+inSupportedLocation。映射（对齐 check.sh 顺序）：
 *  region 空→blocked；JP→ok；preview/unavailable→blocked；inSupportedLocation:false→partial；:true→ok；其余→timeout。
 */
export const checkDisney: Checker = async (fetch) => {
  const bearer = { ...HDRS, Authorization: `Bearer ${DISNEY.bearer}` };

  // ① devices → assertion。
  const devRes = await fetch({
    url: DISNEY.devicesUrl,
    method: 'POST',
    headers: { ...bearer, 'Content-Type': 'application/json; charset=UTF-8' },
    body: DISNEY.devicesBody,
  });
  if (!reachable(devRes)) return { status: 'timeout' };
  if (hasCI(devRes.body, DISNEY.errorMarker)) return { status: 'blocked' }; // 403 ERROR = IP 被 Disney 封
  const assertion = /"assertion"\s*:\s*"([^"]+)"/.exec(devRes.body)?.[1];
  if (!assertion) return { status: 'timeout' };

  // ② token（grant body 模板注入 assertion）→ refresh_token。403 ERROR / forbidden-location → blocked。
  const tokRes = await fetch({
    url: DISNEY.tokenUrl,
    method: 'POST',
    headers: { ...bearer, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: DISNEY.tokenBodyTemplate.replace(DISNEY.assertionPlaceholder, () => assertion),
  });
  if (hasCI(tokRes.body, DISNEY.forbiddenMarker) || hasCI(tokRes.body, DISNEY.errorMarker)) {
    return { status: 'blocked' };
  }
  const refreshToken = /"refresh_token"\s*:\s*"([^"]+)"/.exec(tokRes.body)?.[1];
  if (!reachable(tokRes) || !refreshToken) return { status: 'timeout' };

  // ③ graphql（refreshToken mutation 模板注入 refreshToken；authorization = **裸 token 无 Bearer 前缀**）
  //    → countryCode（region）+ inSupportedLocation。
  const gRes = await fetch({
    url: DISNEY.graphqlUrl,
    method: 'POST',
    headers: {
      ...HDRS,
      Authorization: DISNEY.bearer,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: DISNEY.graphqlBodyTemplate.replace(DISNEY.refreshTokenPlaceholder, () => refreshToken),
  });
  // graphql 传输失败必落 timeout（对齐其余 leg 与 §4「网络失败→timeout，绝不误 block」）：漏此判则 body='' →
  // region=undefined → 下方 `if(!region) return blocked`，把传输失败误判成高置信 blocked 缓存 30min，且 settle/partial
  // 补测只重跑 timeout（非 blocked）→ 错误结果卡死 30min。故须先于 region 映射兜底。
  if (!reachable(gRes)) return { status: 'timeout' };
  const region = /"countryCode"\s*:\s*"([A-Za-z]{2})"/.exec(gRes.body)?.[1]?.toUpperCase();
  const inSupported = /"inSupportedLocation"\s*:\s*(true|false)/.exec(gRes.body)?.[1];

  // ④ 映射（对齐 check.sh 顺序）。region 空 → blocked；JP 特判 → ok（API 报不支持但实为可用）。
  if (!region) return { status: 'blocked' };
  if (region === 'JP') return { status: 'ok', region };

  // ⑤ disneyplus.com 最终 URL preview/unavailable → blocked（只扫 URL，body 不参与）。JP/region 空已先决，此处才需拉取。
  const pv = await fetch({ url: DISNEY.previewUrl, headers: HDRS });
  const finalUrl = [DISNEY.previewUrl, ...pv.redirectChain.map((h) => h.location)]
    .join(' ')
    .toLowerCase();
  if (DISNEY.previewMarkers.some((m) => finalUrl.includes(m))) return { status: 'blocked', region };

  // ⑥ inSupportedLocation 显式信号；缺失 → 无法判定 → timeout（绝不误 block）。
  if (inSupported === 'false') return { status: 'partial', region }; // Disney 明确「即将上线」
  if (inSupported === 'true') return { status: 'ok', region };
  return { status: 'timeout', region };
};

/**
 * Spotify（§18）：**GET ?validate=1** signup 端点，解析 status/country/is_country_launched。
 * 治全误判 blocked——原 POST + 过时固定 body 被 anti-abuse 指纹拉黑返 status:320「代理」即使家宽（见 unlock-endpoints SPOTIFY）。
 * 网络失败/无 status→timeout；`status` 320/120→blocked（真·代理/datacenter flag，GET 面实测不误触）；
 * country/is_country_launched 缺→timeout；is_country_launched:false→blocked（地区未开服）；is_country_launched:true+country→ok。
 * 注：validate 面正常返 `status:1`（非注册面的 311），故不再 gate 311——launched 字段才是地区权威。
 */
export const checkSpotify: Checker = async (fetch) => {
  const res = await fetch({
    url: SPOTIFY.signupUrl,
    method: 'GET',
    headers: { ...HDRS, 'Accept-Language': 'en' },
  });
  if (!reachable(res)) return { status: 'timeout' };
  const statusCode = /"status"\s*:\s*(\d+)/.exec(res.body)?.[1];
  if (!statusCode) return { status: 'timeout' };
  if (statusCode === '320' || statusCode === '120') return { status: 'blocked' }; // 代理/datacenter IP 被 flag
  const region = /"country"\s*:\s*"([^"]+)"/.exec(res.body)?.[1];
  const launched = /"is_country_launched"\s*:\s*(true|false)/.exec(res.body)?.[1];
  if (!region || !launched) return { status: 'timeout' };
  if (launched === 'false') return { status: 'blocked', region };
  return { status: 'ok', region }; // is_country_launched:true + country → 该区已开服 → ok
};

/** serviceId → checker。编排器按 SERVICE_IDS 顺序调用。 */
export const CHECKERS: Record<ServiceId, Checker> = {
  chatgpt: checkChatgpt,
  claude: checkClaude,
  gemini: checkGemini,
  netflix: checkNetflix,
  disney: checkDisney,
  spotify: checkSpotify,
};
