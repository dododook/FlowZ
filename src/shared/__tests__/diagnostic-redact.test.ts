import {
  redactDeep,
  redactUrlValue,
  buildDiagnosticReport,
  REDACTED,
  type DiagnosticReportInput,
} from '../diagnostic-redact';

describe('redactDeep — 密钥脱敏（红线：零明文密钥）', () => {
  it('打码黑名单密钥键（camelCase 与 snake_case 同时命中）', () => {
    const out = redactDeep({
      password: 'p',
      uuid: 'u',
      privateKey: 'a',
      private_key: 'b',
      preSharedKey: 'c',
      pre_shared_key: 'd',
      authKey: 'e',
      auth_key: 'f',
      secret: 'g',
      clashApiSecret: 'h',
      token: 'i',
      plugin_opts: 'host;pwd',
      privacyPassword: 'j',
    }) as Record<string, unknown>;
    for (const k of Object.keys(out)) {
      expect(out[k]).toBe(REDACTED);
    }
  });

  it('保留结构/非密钥字段（能判形态、不泄密）', () => {
    const src = {
      type: 'vless',
      tag: 'node-1',
      server: '1.2.3.4',
      server_port: 443,
      network: 'ws',
      security: 'reality',
      sni: 'a.com',
      server_name: 'a.com',
      method: 'aes-128-gcm',
      flow: 'xtls-rprx-vision',
      fingerprint: 'chrome',
      alpn: ['h2', 'http/1.1'],
      public_key: 'PUBKEY_IS_PUBLIC',
      short_id: '01ab',
      enabled: true,
      port: 7890,
    };
    expect(redactDeep(src)).toEqual(src);
  });

  it('url 键仅保留 origin，path/query 打码（订阅 token 可能在任一处）', () => {
    const out = redactDeep({ url: 'https://sub.example.com/path?token=SECRET&x=1' }) as {
      url: string;
    };
    expect(out.url).toBe(`https://sub.example.com/${REDACTED}`);
  });

  it('嵌套对象在密钥键下整体打码，不向下泄漏', () => {
    const out = redactDeep({
      shadowsocksSettings: { method: 'aes-256-gcm', password: 'topsecret' },
      secret: { nested: 'leak?' },
    }) as any;
    expect(out.shadowsocksSettings.method).toBe('aes-256-gcm');
    expect(out.shadowsocksSettings.password).toBe(REDACTED);
    expect(out.secret).toBe(REDACTED); // 对象整体打码
  });

  it('custom 协议：按节点 secretKeys 额外打码 outbound 内的密钥键', () => {
    const out = redactDeep({
      protocol: 'custom',
      customSettings: {
        outbound: { type: 'x', server: '1.2.3.4', apiKey: 'SECRET_KEY', port: 443 },
        secretKeys: ['apiKey'],
      },
    }) as any;
    expect(out.customSettings.outbound.apiKey).toBe(REDACTED);
    expect(out.customSettings.outbound.server).toBe('1.2.3.4');
    expect(out.customSettings.outbound.type).toBe('x');
  });

  it('H1 回归：展平后的 custom outbound（无 customSettings 包装）经 extraSecretKeys 打码', () => {
    // 模拟 generateProxyOutbound 展平：customSettings 已剥离，密钥键裸露在 outbound 顶层。
    // DiagnosticService 汇总各 custom 节点 secretKeys 作 extraSecretKeys 传入，否则生成配置段会泄漏。
    const flattened = {
      type: 'x',
      tag: 'proxy-1',
      server: '1.2.3.4',
      server_port: 443,
      myCustomSecret: 'LEAK',
    };
    const out = redactDeep(flattened, new Set(['mycustomsecret'])) as any;
    expect(out.myCustomSecret).toBe(REDACTED);
    expect(out.server).toBe('1.2.3.4'); // 结构保留
  });

  it('psk 在全局黑名单（snell 兜底：用户未声明 secretKeys 时也打码）', () => {
    const out = redactDeep({ type: 'snell', psk: 'SECRET', server: '1.2.3.4' }) as any;
    expect(out.psk).toBe(REDACTED);
    expect(out.server).toBe('1.2.3.4');
  });

  it('数组与 null/undefined 正确处理', () => {
    const out = redactDeep({
      servers: [{ password: 'x', server: 'a' }],
      a: null,
      b: undefined,
    }) as any;
    expect(out.servers[0].password).toBe(REDACTED);
    expect(out.servers[0].server).toBe('a');
    expect(out.a).toBeNull();
    expect(out.b).toBeUndefined();
  });

  it('不就地修改原对象', () => {
    const src = { password: 'p' };
    redactDeep(src);
    expect(src.password).toBe('p');
  });
});

describe('redactUrlValue', () => {
  it('有 query → 仅 origin', () => {
    expect(redactUrlValue('https://a.com/p?token=x')).toBe(`https://a.com/${REDACTED}`);
  });
  it('有 path（token 可能嵌 path）→ 仅 origin', () => {
    expect(redactUrlValue('https://a.com/abcTOKEN/clash')).toBe(`https://a.com/${REDACTED}`);
  });
  it('纯 origin 原样', () => {
    expect(redactUrlValue('https://a.com')).toBe('https://a.com');
    expect(redactUrlValue('https://a.com/')).toBe('https://a.com');
  });
  it('非法 url 截断到 ? 前', () => {
    expect(redactUrlValue('not a url?token=x')).toBe(`not a url?${REDACTED}`);
  });
});

describe('buildDiagnosticReport', () => {
  const base: DiagnosticReportInput = {
    generatedAt: '2026-06-17T00:00:00.000Z',
    app: { flowzVersion: '1.0.0', coreVersion: '1.13.0', os: 'win32 x64 10.0', electron: '42.0.0' },
    runtime: {
      proxyMode: 'smart',
      proxyModeType: 'systemProxy',
      proxyRunning: true,
      startedViaHelper: false,
      systemProxy: '127.0.0.1:7890',
      nodeDomainResolver: 'auto',
      logLevel: 'info',
      captureActive: false,
    },
    redactedUserConfig: { logLevel: 'info' },
    redactedSingboxConfig: { log: { level: 'info' } },
    appLogTail: 'line1\nline2',
    singboxLogTail: '',
  };

  it('含核心区块与脱敏 JSON', () => {
    const md = buildDiagnosticReport(base);
    expect(md).toContain('# FlowZ 诊断报告');
    expect(md).toContain('## 环境');
    expect(md).toContain('## 运行态');
    expect(md).toContain('## 生成的 sing-box 配置（脱敏）');
    expect(md).toContain('"level": "info"');
    expect(md).toContain('line1\nline2');
  });

  it('空日志 tail 渲染为占位「(空)」', () => {
    const md = buildDiagnosticReport(base);
    expect(md).toContain('(空)');
  });

  it('有 hint 时输出提示行', () => {
    const md = buildDiagnosticReport({ ...base, hint: '建议开启诊断采集' });
    expect(md).toContain('建议开启诊断采集');
  });

  it('F1 回归：日志含 ``` 不破坏围栏（动态升级到更长围栏）', () => {
    // 机场可控的节点名/日志含三反引号 → 朴素 fence 会被提前闭合。动态围栏须用更长的反引号包裹。
    const evil = 'before\n```\n# injected\nafter';
    const md = buildDiagnosticReport({ ...base, appLogTail: evil });
    // 内容原样保留
    expect(md).toContain('# injected');
    // 该段围栏必须比内容里的 3 反引号更长（≥4），否则 ``` 会提前闭合
    expect(md).toContain('````text\n' + evil + '\n````');
  });

  it('F1 回归：config JSON 内含反引号也用动态围栏', () => {
    const md = buildDiagnosticReport({
      ...base,
      redactedUserConfig: { name: 'a```b' },
    });
    expect(md).toContain('````json');
  });
});
