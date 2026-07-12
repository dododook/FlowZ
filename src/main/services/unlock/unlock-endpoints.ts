/**
 * 解锁检测端点 / 判定 marker / titleId / apiKey / 支持国家清单 —— **全集中此单文件**。
 *
 * 为何单文件：社区检测端点/marker 半年级漂移（Netflix titleId、Disney 公开 apiKey、Gemini 可用性
 * marker、OpenAI 支持国家清单）。漂移时**只改此处**，不动 checker 逻辑与引擎（见
 * flowz-unlock-detection.md §10 漂移 runbook）。判定法沿用社区标准（RegionRestrictionCheck 系），
 * 具体 marker 以真机对照社区脚本校准为准（§7 第 7 项）。
 */

/** 统一 UA（社区常用桌面 Chrome UA；对端按 UA 分流时保持一致）。 */
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 出口 trace（缓存 key 用）：apex 域 cdn-cgi/trace，与 IpInfoService.EP_CF_TRACE 同源，复用 parseTrace。 */
export const EGRESS_TRACE_URL = 'https://cloudflare.com/cdn-cgi/trace';

/** 单请求超时 / body 上限 / 最大重定向跳数（传输层硬约束，防永挂 + 防大 body 撑内存）。 */
export const REQ_TIMEOUT_MS = 8000;
export const MAX_BODY_BYTES = 1_500_000;
export const MAX_REDIRECTS = 5;

/**
 * 单 checker 总预算（Promise.race 兜底）：收敛 Disney 主链+备法 4 连请求的尾延迟。单请求各有 8s 传输超时，
 * 但串联多请求最坏可累加 → 此处对整个 checker 封顶，超预算落 timeout（有界即可，非精确）。
 */
export const CHECKER_BUDGET_MS = 15_000;

/** ChatGPT：cookie_requirements(r1) + ios 首页(r2) + trace(loc)。判定见 checkers.checkChatgpt。 */
export const CHATGPT = {
  traceUrl: 'https://chat.openai.com/cdn-cgi/trace',
  cookieUrl: 'https://api.openai.com/compliance/cookie_requirements',
  iosUrl: 'https://ios.chat.openai.com/',
  /** r1（cookie_requirements）body 命中即「不支持地区」（对齐 check.sh：r1 只查 unsupported_country）。 */
  cookieBlockMarker: 'unsupported_country',
  /** r2（ios 首页）body 命中即「VPN/代理被识别」（对齐 check.sh：r2 只查 VPN）。 */
  iosBlockMarker: 'VPN',
} as const;

/** Claude：claude.ai/（manual redirect）+ trace(loc)。判定见 checkers.checkClaude。 */
export const CLAUDE = {
  homeUrl: 'https://claude.ai/',
  traceUrl: 'https://claude.ai/cdn-cgi/trace',
  /** 重定向 Location 命中即封禁（地区不可用）。 */
  blockMarker: 'app-unavailable-in-region',
} as const;

/** Gemini：gemini.google.com/（跟随重定向）。marker 脆弱、低置信（§4 标注），真机校准。 */
export const GEMINI = {
  homeUrl: 'https://gemini.google.com/',
  /** 可用性 marker（社区经验值，脆弱）。命中→ok，缺失→blocked（对齐 check.sh WebTest_Gemini）。 */
  availableMarker: '45631641,null,true',
  /** region（仅展示，可缺）：body 里 ,2,1,200,"XXX" 提 3 字母地区码（check.sh 同正则）。 */
  regionRe: /,2,1,200,"([A-Z]{3})"/,
} as const;

/** Netflix：两非自制 titleId（对齐 check.sh MediaUnlockTest_Netflix），manual redirect。判定见 checkers.checkNetflix。 */
export const NETFLIX = {
  /** 非自制 title #1（LEGO Ninjago 81280792）。 */
  nonOriginalUrl: 'https://www.netflix.com/title/81280792',
  /** 非自制 title #2（Breaking Bad 70143836）。两个都命中 Oh no! = 非自制均不可看 → 仅自制剧 partial。 */
  nonOriginalUrl2: 'https://www.netflix.com/title/70143836',
  /** body 命中即该 title 在本地区不可看（Netflix "Oh no!" 错误页）。 */
  ohNoMarker: 'Oh no!',
  /** Netflix **未在本国提供业务**（大陆 CN 等）标记：HTTP 403 + body "Not Available"（无 per-title 的 "Oh no!"）。
   *  区别于 per-title 地区限制的 "Oh no!"（那是国家有 Netflix 但该片不可看=partial）。命中→blocked，堵「可达+无
   *  Oh no! 即判 ok」的负向证据谬误（大陆阿里云实测 403+Not Available 被误判完整解锁）。 */
  notAvailableMarker: 'Not Available',
  /**
   * region（仅展示，可缺）：countryName 前最近的 "id" 值（本地化 payload；check.sh 同思路）。`[^{}]` 限同一
   * JSON 对象内、长度封顶 —— 防跨对象误取与大 body 回溯失控。缺失时由重定向本地化前缀兜底（见 checker）。
   */
  regionRe: /"id":"([^"]{1,32})"[^{}]{0,200}?"countryName"/,
} as const;

/**
 * Disney+：bamgrid 三段串联 devices→token→graphql（对齐 lmc999/RegionRestrictionCheck 系 `disney_check`），
 * 末段再打 disneyplus.com 取最终 URL 判 preview/未上线。判定见 checkers.checkDisney。
 */
export const DISNEY = {
  devicesUrl: 'https://disney.api.edge.bamgrid.com/devices',
  tokenUrl: 'https://disney.api.edge.bamgrid.com/token',
  graphqlUrl: 'https://disney.api.edge.bamgrid.com/graph/v1/device/graphql',
  /** disneyplus.com 首页（跟随重定向后取最终 URL 判 preview）。 */
  previewUrl: 'https://www.disneyplus.com/',
  /**
   * 公开静态 Bearer（disney&browser&1.0.0）。devices/token 用 `Bearer <bearer>`，graphql 用**裸 token**
   * （无 `Bearer ` 前缀，见 checker）。源 lmc999/RegionRestrictionCheck；漂移时同 cookie 模板一并刷新。
   */
  bearer: 'ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84',
  /** devices 探针 body（固定）。 */
  devicesBody: JSON.stringify({
    deviceFamily: 'browser',
    applicationRuntime: 'chrome',
    deviceProfile: 'windows',
    attributes: {},
  }),
  /**
   * token grant body 模板（token-exchange，form-urlencoded）。**源 lmc999/RegionRestrictionCheck cookies 第 1 行，
   * 原样进常量**；漂移时从 https://raw.githubusercontent.com/lmc999/RegionRestrictionCheck/main/cookies 刷新。
   * 占位 `DISNEYASSERTION` 由 checker 替换为 devices 拿到的 assertion。
   */
  tokenBodyTemplate:
    'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&latitude=0&longitude=0&platform=browser&subject_token=DISNEYASSERTION&subject_token_type=urn%3Abamtech%3Aparams%3Aoauth%3Atoken-type%3Adevice',
  /** token body 里被替换的 assertion 占位符。 */
  assertionPlaceholder: 'DISNEYASSERTION',
  /**
   * graphql refreshToken mutation body 模板。**源 lmc999/RegionRestrictionCheck cookies 第 8 行，原样进常量**
   * （字面 `\n` 转义原封保留）；漂移时从 https://raw.githubusercontent.com/lmc999/RegionRestrictionCheck/main/cookies
   * 刷新。占位 `ILOVEDISNEY` 由 checker 替换为 token 拿到的 refresh_token。
   */
  graphqlBodyTemplate:
    '{"query":"mutation refreshToken($input: RefreshTokenInput!) {\\n            refreshToken(refreshToken: $input) {\\n                activeSession {\\n                    sessionId\\n                }\\n            }\\n        }","variables":{"input":{"refreshToken":"ILOVEDISNEY"}}}',
  /** graphql body 里被替换的 refresh_token 占位符。 */
  refreshTokenPlaceholder: 'ILOVEDISNEY',
  /** token 响应 body 命中即 Disney 地区拒绝 → blocked（对齐 check.sh MediaUnlockTest_DisneyPlus）。 */
  forbiddenMarker: 'forbidden-location',
  /**
   * CloudFront/Akamai `403 ERROR` bot 页 —— devices/token 响应命中即 blocked（对齐 check.sh：IP Banned By Disney+）。
   */
  errorMarker: '403 ERROR',
  /**
   * disneyplus.com 最终 URL（含跳转链）命中即「未上线 / preview」→ blocked（对齐 check.sh）。只扫 URL（路径
   * marker），body 不参与——避免合法 body 子串误判。
   */
  previewMarkers: ['preview', 'unavailable'],
} as const;

/**
 * Spotify：signup 端点 **GET ?validate=1** 判地区可用性。判定见 checkers.checkSpotify。
 * §18：原用 POST + 固定注册 body（源 RRC，key/identifier_token/displayname 多年不变）已被 Spotify anti-abuse 全局
 * 指纹拉黑 → 即使原生家宽也返 status:320「检测到代理」→ 全误判 blocked。改 GET ?validate=1（无 body、无需 email、
 * 不触发注册 anti-abuse 面），响应仍带 country/is_country_launched 地区信号（实测同一 IP GET 面干净、POST 面 320）。
 * 漂移 runbook（GET 面若也失效）：改解析 open.spotify.com 内嵌 appServerConfig(base64 JSON) 的 market 字段
 * （UnlockTests transnation/Spotify.go 现行方案，彻底避开 spclient 域）。
 */
export const SPOTIFY = {
  signupUrl: 'https://spclient.wg.spotify.com/signup/public/v1/account?validate=1',
} as const;
