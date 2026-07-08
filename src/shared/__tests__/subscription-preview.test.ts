import {
  classifySubscriptionError,
  SUBSCRIPTION_ERROR_I18N_KEY,
  type SubscriptionErrorKind,
} from '../subscription-preview';

describe('classifySubscriptionError（订阅预检错误分类）', () => {
  it('httpStatus ≥400 最高优先 → http（带状态码）', () => {
    expect(classifySubscriptionError({ httpStatus: 403 })).toEqual({
      errorKind: 'http',
      httpStatus: 403,
    });
    expect(classifySubscriptionError({ httpStatus: 502, code: 'ECONNREFUSED' })).toEqual({
      errorKind: 'http',
      httpStatus: 502,
    });
    // <400 不算 http（不该有，但防御）
    expect(classifySubscriptionError({ httpStatus: 302 }).errorKind).not.toBe('http');
  });

  it('网络错误码：ENOTFOUND→dns / ETIMEDOUT→timeout / ECONNREFUSED→refused', () => {
    expect(classifySubscriptionError({ code: 'ENOTFOUND' }).errorKind).toBe('dns');
    expect(classifySubscriptionError({ code: 'EAI_AGAIN' }).errorKind).toBe('dns');
    expect(classifySubscriptionError({ code: 'ETIMEDOUT' }).errorKind).toBe('timeout');
    expect(classifySubscriptionError({ code: 'UND_ERR_CONNECT_TIMEOUT' }).errorKind).toBe('timeout');
    expect(classifySubscriptionError({ code: 'ABORT_ERR' }).errorKind).toBe('timeout');
    expect(classifySubscriptionError({ code: 'ECONNREFUSED' }).errorKind).toBe('refused');
    expect(classifySubscriptionError({ code: 'EHOSTUNREACH' }).errorKind).toBe('refused');
  });

  it('Electron net::ERR_* / 英文关键字兜底（code 藏在 message）', () => {
    expect(
      classifySubscriptionError({ message: 'net::ERR_NAME_NOT_RESOLVED' }).errorKind
    ).toBe('dns');
    expect(classifySubscriptionError({ message: 'request to x failed, ERR_TIMED_OUT' }).errorKind).toBe(
      'timeout'
    );
    expect(
      classifySubscriptionError({ message: 'net::ERR_CONNECTION_REFUSED' }).errorKind
    ).toBe('refused');
    expect(
      classifySubscriptionError({ message: 'The operation was aborted' }).errorKind
    ).toBe('timeout');
  });

  it('本项目确定性中文文案：体积/协议/空/SSRF/解析', () => {
    expect(classifySubscriptionError({ message: '订阅响应体积超过上限 10MB，已拒绝' }).errorKind).toBe(
      'toolarge'
    );
    expect(
      classifySubscriptionError({ message: '订阅地址协议不支持（仅允许 http/https）: https://x' })
        .errorKind
    ).toBe('scheme');
    expect(classifySubscriptionError({ message: 'sing-box 订阅解析得到 0 个可用节点' }).errorKind).toBe(
      'empty'
    );
    expect(
      classifySubscriptionError({ message: '拒绝访问内网/本机地址' }).errorKind
    ).toBe('ssrf');
    expect(classifySubscriptionError({ message: '重定向次数超过上限' }).errorKind).toBe('ssrf');
    expect(
      classifySubscriptionError({ message: 'Clash YAML 解析失败: bad indentation' }).errorKind
    ).toBe('parse');
    expect(
      classifySubscriptionError({ message: '检测到 Clash 订阅特征，但文档结构异常' }).errorKind
    ).toBe('parse');
  });

  it('http 文案优先于 refused：empty/scheme/toolarge 是主动 throw 文案，先于网络码判', () => {
    // 体积超限文案 + 恰好 message 含 refused 关键字（极端），体积优先（本项目主动 throw 稳定文案）
    expect(
      classifySubscriptionError({ message: '订阅响应体积超过上限，connection refused 噪声' }).errorKind
    ).toBe('toolarge');
  });

  it('未覆盖形态 → unknown（不误判，UI 给通用文案 + 原始 message 上报）', () => {
    expect(classifySubscriptionError({ message: 'something entirely novel' }).errorKind).toBe(
      'unknown'
    );
    expect(classifySubscriptionError({}).errorKind).toBe('unknown');
  });

  it('每个 errorKind 都有 i18n title/detail key（无遗漏，防新增分类漏配文案）', () => {
    const kinds: SubscriptionErrorKind[] = [
      'dns',
      'timeout',
      'refused',
      'http',
      'ssrf',
      'scheme',
      'toolarge',
      'parse',
      'empty',
      'unknown',
    ];
    for (const k of kinds) {
      expect(SUBSCRIPTION_ERROR_I18N_KEY[k]?.title).toMatch(/^sub\.preview\./);
      expect(SUBSCRIPTION_ERROR_I18N_KEY[k]?.detail).toMatch(/^sub\.preview\./);
    }
  });
});
