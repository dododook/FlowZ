/**
 * checker 单测（node env，全 mock 注入 fake fetch，零网络）。判定法逐服务对齐 check.sh。
 * 覆盖 6 服务 × {ok/partial/blocked/timeout/region 提取/畸形响应不抛}：
 *  - ChatGPT r1/r2 四象限（两净 ok / 两脏 blocked / 一净一脏 partial）；Claude 精确 URL/app-unavailable/unknown→timeout；
 *  - Gemini marker 有无 + 3 字母 region；Netflix 双非自制 Oh no! 组合（两脏 partial / 任一可看 ok）；
 *  - Disney devices/token 403·forbidden→blocked、region 空→blocked、preview→blocked、inSupportedLocation false→partial/true→ok；
 *  - Spotify signup status 311+launched→ok / 320·120·launched:false→blocked / 缺字段→timeout。
 */
import {
  checkChatgpt,
  checkClaude,
  checkGemini,
  checkNetflix,
  checkDisney,
  checkSpotify,
  CHECKERS,
} from '../checkers';
import type { UnlockFetch, UnlockResponse } from '../unlock-http';
import { CHATGPT, CLAUDE, DISNEY, GEMINI, NETFLIX, SPOTIFY } from '../unlock-endpoints';

function res(over: Partial<UnlockResponse> = {}): UnlockResponse {
  return { status: 200, headers: {}, body: '', truncated: false, redirectChain: [], ...over };
}
const trace = (cc: string) => res({ status: 200, body: `ip=1.2.3.4\nloc=${cc}\n` });
/** 按 url 子串路由的 fake fetch（取最长匹配 needle，避免 home 是 trace 前缀时误命中）。 */
function fakeFetch(routes: Array<[string, UnlockResponse]>): UnlockFetch {
  const sorted = [...routes].sort((a, b) => b[0].length - a[0].length);
  return (req) => {
    for (const [needle, r] of sorted) if (req.url.includes(needle)) return Promise.resolve(r);
    return Promise.resolve(res({ status: 0, error: 'unrouted' }));
  };
}

describe('checkChatgpt', () => {
  it('ok：cookie/ios 两净 + trace loc', async () => {
    const f = fakeFetch([
      [CHATGPT.traceUrl, trace('US')],
      [CHATGPT.cookieUrl, res({ body: '{}' })],
      [CHATGPT.iosUrl, res({ body: '<html>ok</html>' })],
    ]);
    expect(await checkChatgpt(f)).toEqual({ status: 'ok', region: 'US' });
  });
  it('blocked：cookie + ios 两脏', async () => {
    const f = fakeFetch([
      [CHATGPT.traceUrl, trace('CN')],
      [CHATGPT.cookieUrl, res({ body: '{"unsupported_country":true}' })],
      [CHATGPT.iosUrl, res({ body: 'access via VPN denied' })],
    ]);
    expect(await checkChatgpt(f)).toEqual({ status: 'blocked', region: 'CN' });
  });
  it('partial：r1 净 r2 脏（web-only）', async () => {
    const f = fakeFetch([
      [CHATGPT.traceUrl, trace('HK')],
      [CHATGPT.cookieUrl, res({ body: '{}' })],
      [CHATGPT.iosUrl, res({ body: 'blocked via VPN' })],
    ]);
    expect(await checkChatgpt(f)).toEqual({ status: 'partial', region: 'HK' });
  });
  it('partial：r1 脏 r2 净（mobile-only；ios 只查 VPN 不查 unsupported_country）', async () => {
    const f = fakeFetch([
      [CHATGPT.traceUrl, trace('HK')],
      [CHATGPT.cookieUrl, res({ body: '{"unsupported_country":1}' })],
      // ios 含 unsupported_country（ios 不查此词）但无 VPN → ios 净
      [CHATGPT.iosUrl, res({ body: 'ios page mentions unsupported_country only' })],
    ]);
    expect(await checkChatgpt(f)).toEqual({ status: 'partial', region: 'HK' });
  });
  it('blocked：ios 小写 vpn 也命中（大小写不敏感，N1）', async () => {
    const f = fakeFetch([
      [CHATGPT.traceUrl, trace('CN')],
      [CHATGPT.cookieUrl, res({ body: '{"unsupported_country":true}' })],
      [CHATGPT.iosUrl, res({ body: 'blocked via vpn' })],
    ]);
    expect(await checkChatgpt(f)).toEqual({ status: 'blocked', region: 'CN' });
  });
  it('timeout：任一端点不可达', async () => {
    const f = fakeFetch([
      [CHATGPT.cookieUrl, res({ status: 0, error: 'x' })],
      [CHATGPT.iosUrl, res({ body: 'ok' })],
    ]);
    expect(await checkChatgpt(f)).toEqual({ status: 'timeout' });
  });
  it('timeout：cookie/ios 皆不可达', async () => {
    const f = fakeFetch([
      [CHATGPT.traceUrl, res({ status: 0, error: 'x' })],
      [CHATGPT.cookieUrl, res({ status: 0, error: 'x' })],
      [CHATGPT.iosUrl, res({ status: 0, error: 'x' })],
    ]);
    expect(await checkChatgpt(f)).toEqual({ status: 'timeout' });
  });
});

describe('checkClaude', () => {
  it('blocked：最终 URL 含 app-unavailable-in-region', async () => {
    const f = fakeFetch([
      [
        CLAUDE.homeUrl,
        res({
          status: 302,
          redirectChain: [{ status: 302, location: 'https://claude.ai/app-unavailable-in-region' }],
        }),
      ],
      [CLAUDE.traceUrl, trace('CN')],
    ]);
    expect(await checkClaude(f)).toEqual({ status: 'blocked', region: 'CN' });
  });
  it('ok：403 challenge（IP 先过地区门才触发盾，最终 URL 仍精确 https://claude.ai/）', async () => {
    const f = fakeFetch([
      [CLAUDE.homeUrl, res({ status: 403 })],
      [CLAUDE.traceUrl, trace('HK')],
    ]);
    expect(await checkClaude(f)).toEqual({ status: 'ok', region: 'HK' });
  });
  it('timeout：被引到非 claude.ai 域（unknown，撤旧 blocked）', async () => {
    const f = fakeFetch([
      [
        CLAUDE.homeUrl,
        res({
          status: 302,
          redirectChain: [{ status: 302, location: 'https://portal.isp.example/blocked' }],
        }),
      ],
      [CLAUDE.traceUrl, trace('CN')],
    ]);
    expect(await checkClaude(f)).toEqual({ status: 'timeout', region: 'CN' });
  });
  it('ok：200 无跳转', async () => {
    const f = fakeFetch([
      [CLAUDE.homeUrl, res({ status: 200 })],
      [CLAUDE.traceUrl, trace('US')],
    ]);
    expect(await checkClaude(f)).toEqual({ status: 'ok', region: 'US' });
  });
  it('ok：302 跳 claude.ai/login（登出用户正常态；真 Chromium net.request 过盾跟到 /login → 落 claude.ai 域即可用，真机根因修复）', async () => {
    const f = fakeFetch([
      [
        CLAUDE.homeUrl,
        res({ status: 200, redirectChain: [{ status: 302, location: 'https://claude.ai/login' }] }),
      ],
      [CLAUDE.traceUrl, trace('SG')],
    ]);
    expect(await checkClaude(f)).toEqual({ status: 'ok', region: 'SG' });
  });
  it('timeout：网络错', async () => {
    const f = fakeFetch([
      [CLAUDE.homeUrl, res({ status: 0, error: 'x' })],
      [CLAUDE.traceUrl, res({ status: 0, error: 'x' })],
    ]);
    expect(await checkClaude(f)).toEqual({ status: 'timeout', region: undefined });
  });
});

describe('checkGemini', () => {
  it('ok：可用性 marker + 3 字母 region', async () => {
    const f = fakeFetch([
      [GEMINI.homeUrl, res({ body: `x ${GEMINI.availableMarker} y ,2,1,200,"USA" z` })],
    ]);
    expect(await checkGemini(f)).toEqual({ status: 'ok', region: 'USA' });
  });
  it('ok：可用性 marker 无 region', async () => {
    const f = fakeFetch([[GEMINI.homeUrl, res({ body: `x ${GEMINI.availableMarker} y` })]]);
    expect(await checkGemini(f)).toEqual({ status: 'ok' });
  });
  it('blocked：缺可用性 marker（撤 H4，直接 blocked）', async () => {
    const f = fakeFetch([[GEMINI.homeUrl, res({ body: 'random no marker' })]]);
    expect(await checkGemini(f)).toEqual({ status: 'blocked' });
  });
  it('timeout：网络错', async () => {
    const f = fakeFetch([[GEMINI.homeUrl, res({ status: 0, error: 'x' })]]);
    expect(await checkGemini(f)).toEqual({ status: 'timeout' });
  });
});

describe('checkNetflix（双非自制 Oh no! 组合）', () => {
  const loc = (u: string) => res({ status: 200, redirectChain: [{ status: 302, location: u }] });
  it('ok：两非自制皆可看 + 本地化前缀 region', async () => {
    const f = fakeFetch([
      [NETFLIX.nonOriginalUrl, loc('https://www.netflix.com/hk-en/title/81280792')],
      [NETFLIX.nonOriginalUrl2, res({ status: 200 })],
    ]);
    expect(await checkNetflix(f)).toEqual({ status: 'ok', region: 'HK' });
  });
  it('partial：两个都含 Oh no!（非自制均不可看 → 仅自制剧）', async () => {
    const f = fakeFetch([
      [NETFLIX.nonOriginalUrl, res({ status: 200, body: 'Oh no! something went wrong' })],
      [NETFLIX.nonOriginalUrl2, res({ status: 200, body: 'Oh no! error' })],
    ]);
    expect(await checkNetflix(f)).toEqual({ status: 'partial', region: 'US' });
  });
  it('ok：仅一个含 Oh no!（任一可看）', async () => {
    const f = fakeFetch([
      [NETFLIX.nonOriginalUrl, res({ status: 200, body: 'Oh no! blocked' })],
      [NETFLIX.nonOriginalUrl2, res({ status: 200, body: 'playable' })],
    ]);
    expect(await checkNetflix(f)).toEqual({ status: 'ok', region: 'US' });
  });
  it('blocked：Netflix 未在本国提供（403 + Not Available，无 Oh no!）——大陆阿里云实测误判修复', async () => {
    const f = fakeFetch([
      [NETFLIX.nonOriginalUrl, res({ status: 403, body: 'Not Available' })],
      [NETFLIX.nonOriginalUrl2, res({ status: 403, body: 'Not Available' })],
    ]);
    expect(await checkNetflix(f)).toEqual({ status: 'blocked' });
  });
  it('blocked：403 无 body 文案也判（403 是国家级可靠信号，合法解锁区不返 403）', async () => {
    const f = fakeFetch([
      [NETFLIX.nonOriginalUrl, res({ status: 403 })],
      [NETFLIX.nonOriginalUrl2, res({ status: 403 })],
    ]);
    expect(await checkNetflix(f)).toEqual({ status: 'blocked' });
  });
  it('不误伤：仅一个 403（另一个 200 可看）→ ok（非国家级，至少一片可看）', async () => {
    const f = fakeFetch([
      [NETFLIX.nonOriginalUrl, res({ status: 403 })],
      [NETFLIX.nonOriginalUrl2, res({ status: 200, body: 'playable' })],
    ]);
    expect(await checkNetflix(f)).toEqual({ status: 'ok' });
  });
  it('ok：body id/countryName 提 region（优先于重定向前缀）', async () => {
    const f = fakeFetch([
      [
        NETFLIX.nonOriginalUrl,
        res({ status: 200, body: '...{"id":"JP","name":"x","countryName":"Japan"}...' }),
      ],
      [NETFLIX.nonOriginalUrl2, res({ status: 200 })],
    ]);
    expect(await checkNetflix(f)).toEqual({ status: 'ok', region: 'JP' });
  });
  it('ok：无前缀 = US', async () => {
    const f = fakeFetch([
      [NETFLIX.nonOriginalUrl, res({ status: 200 })],
      [NETFLIX.nonOriginalUrl2, res({ status: 200 })],
    ]);
    expect(await checkNetflix(f)).toEqual({ status: 'ok', region: 'US' });
  });
  it('timeout：任一不可达（不误判 blocked）', async () => {
    const f = fakeFetch([
      [NETFLIX.nonOriginalUrl, res({ status: 0, error: 'x' })],
      [NETFLIX.nonOriginalUrl2, res({ status: 200 })],
    ]);
    expect(await checkNetflix(f)).toEqual({ status: 'timeout' });
  });
  it('ok：bare /jp/ 前缀（无 lang）→ region JP', async () => {
    const f = fakeFetch([
      [NETFLIX.nonOriginalUrl, loc('https://www.netflix.com/jp/title/81280792')],
      [NETFLIX.nonOriginalUrl2, res({ status: 200 })],
    ]);
    expect(await checkNetflix(f)).toEqual({ status: 'ok', region: 'JP' });
  });
  it('ok：bare /en/ 语言段不误判为地区 → 无前缀=US', async () => {
    const f = fakeFetch([
      [NETFLIX.nonOriginalUrl, loc('https://www.netflix.com/en/title/81280792')],
      [NETFLIX.nonOriginalUrl2, res({ status: 200 })],
    ]);
    expect(await checkNetflix(f)).toEqual({ status: 'ok', region: 'US' });
  });
});

describe('checkDisney（bamgrid 三段 devices→token→graphql + disneyplus preview）', () => {
  const devOk = res({ status: 200, body: '{"assertion":"ASSERT"}' });
  const tokOk = res({ status: 200, body: '{"refresh_token":"RT"}' });
  /** 无 preview marker 的 disneyplus 首页跳转（走到本地化 home）。 */
  const previewClean = res({
    status: 200,
    redirectChain: [{ status: 302, location: 'https://www.disneyplus.com/en-us/home' }],
  });
  const graphql = (body: string) => res({ status: 200, body });

  it('blocked：token 命中 forbidden-location', async () => {
    const f = fakeFetch([
      [DISNEY.devicesUrl, devOk],
      [DISNEY.tokenUrl, res({ status: 403, body: '{"errors":[{"code":"forbidden-location"}]}' })],
    ]);
    expect(await checkDisney(f)).toEqual({ status: 'blocked' });
  });
  it('blocked：devices 403 ERROR（对齐 check.sh，撤 L1）', async () => {
    const f = fakeFetch([[DISNEY.devicesUrl, res({ status: 403, body: '<h1>403 ERROR</h1>' })]]);
    expect(await checkDisney(f)).toEqual({ status: 'blocked' });
  });
  it('blocked：token 403 ERROR（对齐 check.sh，撤 L1）', async () => {
    const f = fakeFetch([
      [DISNEY.devicesUrl, devOk],
      [
        DISNEY.tokenUrl,
        res({ status: 403, body: 'The request could not be satisfied. 403 ERROR' }),
      ],
    ]);
    expect(await checkDisney(f)).toEqual({ status: 'blocked' });
  });
  it('ok：countryCode==JP 特判（不看 inSupportedLocation/preview）', async () => {
    const f = fakeFetch([
      [DISNEY.devicesUrl, devOk],
      [DISNEY.tokenUrl, tokOk],
      [DISNEY.graphqlUrl, graphql('{"inSupportedLocation":false,"countryCode":"JP"}')],
    ]);
    expect(await checkDisney(f)).toEqual({ status: 'ok', region: 'JP' });
  });
  it('ok：inSupportedLocation:true 且非 preview', async () => {
    const f = fakeFetch([
      [DISNEY.devicesUrl, devOk],
      [DISNEY.tokenUrl, tokOk],
      [DISNEY.graphqlUrl, graphql('{"inSupportedLocation":true,"countryCode":"US"}')],
      [DISNEY.previewUrl, previewClean],
    ]);
    expect(await checkDisney(f)).toEqual({ status: 'ok', region: 'US' });
  });
  it('partial：inSupportedLocation:false 且非 preview（对齐 check.sh：即将上线，撤旧 blocked）', async () => {
    const f = fakeFetch([
      [DISNEY.devicesUrl, devOk],
      [DISNEY.tokenUrl, tokOk],
      [DISNEY.graphqlUrl, graphql('{"inSupportedLocation":false,"countryCode":"TW"}')],
      [DISNEY.previewUrl, previewClean],
    ]);
    expect(await checkDisney(f)).toEqual({ status: 'partial', region: 'TW' });
  });
  it('blocked：disneyplus 最终 URL 含 preview（对齐 check.sh，撤旧 partial；先于 inSupportedLocation）', async () => {
    const f = fakeFetch([
      [DISNEY.devicesUrl, devOk],
      [DISNEY.tokenUrl, tokOk],
      [DISNEY.graphqlUrl, graphql('{"inSupportedLocation":true,"countryCode":"IN"}')],
      [
        DISNEY.previewUrl,
        res({
          status: 200,
          redirectChain: [{ status: 302, location: 'https://www.disneyplus.com/en-in/preview' }],
        }),
      ],
    ]);
    expect(await checkDisney(f)).toEqual({ status: 'blocked', region: 'IN' });
  });
  it('blocked：graphql 无 countryCode（region 空，对齐 check.sh，撤 L1）', async () => {
    const f = fakeFetch([
      [DISNEY.devicesUrl, devOk],
      [DISNEY.tokenUrl, tokOk],
      [DISNEY.graphqlUrl, graphql('{"inSupportedLocation":false}')],
    ]);
    expect(await checkDisney(f)).toEqual({ status: 'blocked' });
  });
  it('timeout：region 有但无 inSupportedLocation 信号（无法判定，不误 block）', async () => {
    const f = fakeFetch([
      [DISNEY.devicesUrl, devOk],
      [DISNEY.tokenUrl, tokOk],
      [DISNEY.graphqlUrl, graphql('{"countryCode":"US"}')],
      [DISNEY.previewUrl, previewClean],
    ]);
    expect(await checkDisney(f)).toEqual({ status: 'timeout', region: 'US' });
  });
  it('timeout：devices 网络失败', async () => {
    const f = fakeFetch([[DISNEY.devicesUrl, res({ status: 0, error: 'x' })]]);
    expect(await checkDisney(f)).toEqual({ status: 'timeout' });
  });
  it('timeout：devices 200 但畸形 body 提不到 assertion', async () => {
    const f = fakeFetch([[DISNEY.devicesUrl, res({ status: 200, body: 'NOT_JSON<<<' })]]);
    expect(await checkDisney(f)).toEqual({ status: 'timeout' });
  });
  it('timeout：token 网络失败（提不到 refresh_token）', async () => {
    const f = fakeFetch([
      [DISNEY.devicesUrl, devOk],
      [DISNEY.tokenUrl, res({ status: 0, error: 'x' })],
    ]);
    expect(await checkDisney(f)).toEqual({ status: 'timeout' });
  });
});

describe('checkSpotify', () => {
  const sp = (body: string) => res({ status: 200, body });
  it('ok：validate 面 status:1 + is_country_launched true + country（不再 gate 311）', async () => {
    const f = fakeFetch([
      [SPOTIFY.signupUrl, sp('{"status":1,"country":"US","is_country_launched":true}')],
    ]);
    expect(await checkSpotify(f)).toEqual({ status: 'ok', region: 'US' });
  });
  it('blocked：status 320（代理/datacenter IP 被 Spotify flag）', async () => {
    const f = fakeFetch([
      [SPOTIFY.signupUrl, sp('{"status":320,"errors":{"generic_error":"proxy service"}}')],
    ]);
    expect(await checkSpotify(f)).toEqual({ status: 'blocked' });
  });
  it('blocked：status 120', async () => {
    const f = fakeFetch([[SPOTIFY.signupUrl, sp('{"status":120}')]]);
    expect(await checkSpotify(f)).toEqual({ status: 'blocked' });
  });
  it('blocked：is_country_launched false', async () => {
    const f = fakeFetch([
      [SPOTIFY.signupUrl, sp('{"status":311,"country":"CN","is_country_launched":false}')],
    ]);
    expect(await checkSpotify(f)).toEqual({ status: 'blocked', region: 'CN' });
  });
  it('timeout：网络失败', async () => {
    const f = fakeFetch([[SPOTIFY.signupUrl, res({ status: 0, error: 'x' })]]);
    expect(await checkSpotify(f)).toEqual({ status: 'timeout' });
  });
  it('timeout：无 status 字段', async () => {
    const f = fakeFetch([[SPOTIFY.signupUrl, sp('{"foo":1}')]]);
    expect(await checkSpotify(f)).toEqual({ status: 'timeout' });
  });
  it('timeout：status 非 311/320/120 且缺 launched', async () => {
    const f = fakeFetch([[SPOTIFY.signupUrl, sp('{"status":200,"country":"US"}')]]);
    expect(await checkSpotify(f)).toEqual({ status: 'timeout' });
  });
});

describe('畸形/空响应不抛（全 checker 兜底）', () => {
  const garbage: UnlockFetch = () => Promise.resolve(res({ status: 200, body: ' <garbage>' }));
  it.each(Object.keys(CHECKERS))('%s resolves 合法状态', async (id) => {
    const r = await CHECKERS[id as keyof typeof CHECKERS](garbage);
    expect(['ok', 'partial', 'blocked', 'timeout']).toContain(r.status);
  });
});
