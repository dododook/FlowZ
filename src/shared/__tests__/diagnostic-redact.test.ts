import {
  redactDeep,
  redactUrlValue,
  buildDiagnosticReport,
  collectNodeIdentifiers,
  redactIdentifiers,
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

  it('WARP 节点 wireguardSettings.warpDevice.token 被脱敏，deviceId 保留（非密钥）', () => {
    // 设备移除特性：token 随节点落 wireguardSettings.warpDevice + 入 pending-deregister.json。
    // SECRET_KEYS 已含 token（归一化键名）→ 递归脱敏天然覆盖；deviceId 非密钥、保留以判形态/可追溯。
    const out = redactDeep({
      protocol: 'wireguard',
      wireguardSettings: {
        privateKey: 'PRIV',
        peerPublicKey: 'PEERPUB',
        warpDevice: { deviceId: 'device-abc-123', token: 'SECRET_TOKEN' },
      },
    }) as any;
    expect(out.wireguardSettings.privateKey).toBe(REDACTED);
    expect(out.wireguardSettings.peerPublicKey).toBe('PEERPUB'); // 公钥公开，保留
    expect(out.wireguardSettings.warpDevice.token).toBe(REDACTED); // 红线：token 脱敏
    expect(out.wireguardSettings.warpDevice.deviceId).toBe('device-abc-123'); // 非密钥，保留
  });

  it('pending-deregister.json 条目数组：每条 token 被脱敏（队列文件若进诊断也安全）', () => {
    const out = redactDeep([
      { deviceId: 'd1', token: 'TOK1', enqueuedAt: 1 },
      { deviceId: 'd2', token: 'TOK2', enqueuedAt: 2 },
    ]) as any[];
    expect(out[0].token).toBe(REDACTED);
    expect(out[1].token).toBe(REDACTED);
    expect(out[0].deviceId).toBe('d1'); // deviceId 保留
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

  it('有 processMetrics 时渲染逐进程内存表（issue #242）', () => {
    const md = buildDiagnosticReport({
      ...base,
      processMetrics: {
        totalMemoryMb: 2348,
        rows: [
          { type: 'Utility', pid: 374035, memoryMb: 2048, cpuPercent: 1, label: 'flowz-stats' },
          { type: 'Browser', pid: 373944, memoryMb: 300, cpuPercent: 0 },
        ],
      },
    });
    expect(md).toContain('## 进程内存');
    expect(md).toContain('| 类型 | PID | 内存(MB) | 峰值(MB) | CPU(%) | 标识 | 创建时刻 |');
    expect(md).toContain('| Utility | 374035 | 2048 |  | 1 | flowz-stats |  |');
    expect(md).toContain('| Browser | 373944 | 300 |  | 0 |  |  |');
    expect(md).toContain('2348 MB');
  });

  it('无 processMetrics 时不渲染进程内存区块（getAppMetrics 失败兜底）', () => {
    const md = buildDiagnosticReport(base);
    expect(md).not.toContain('## 进程内存');
  });

  it('进程内存表不被节点标识符打码误伤（机场把节点命名成纯数字撞表内 PID/内存数字）', () => {
    const md = buildDiagnosticReport({
      ...base,
      appLogTail: 'node 2048 connected', // 日志里的节点名 "2048" 应被正常打码
      nodeIdentifiers: [{ value: '2048', placeholder: '<node-1>' }],
      processMetrics: {
        totalMemoryMb: 2048,
        rows: [{ type: 'Utility', pid: 2048, memoryMb: 2048, cpuPercent: 1, label: 'flowz-stats' }],
      },
    });
    // 表在 redact 之后拼接 → 表内 PID/内存的 2048 原样保留，定位价值不被毁
    expect(md).toContain('| Utility | 2048 | 2048 |  | 1 | flowz-stats |');
    // 但表以外（日志）的同名节点仍被正常打码，脱敏不受影响
    expect(md).toContain('node <node-1> connected');
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

describe('buildDiagnosticReport × issue #242 §6 观测随包新字段', () => {
  const base: DiagnosticReportInput = {
    generatedAt: '2026-07-02T00:00:00.000Z',
    app: { flowzVersion: '4.1.9', coreVersion: '1.13.0', os: 'linux x64 6.0', electron: '42.0.0' },
    runtime: {
      proxyMode: 'smart',
      proxyModeType: 'tun',
      proxyRunning: true,
      logLevel: 'info',
      captureActive: false,
    },
    redactedUserConfig: {},
    redactedSingboxConfig: {},
    appLogTail: '',
    singboxLogTail: '',
  };

  it('进程内存表含峰值(MB)/创建时刻列（源字段存在时填充）', () => {
    const md = buildDiagnosticReport({
      ...base,
      processMetrics: {
        totalMemoryMb: 2048,
        rows: [
          {
            type: 'Utility',
            pid: 100,
            memoryMb: 2048,
            cpuPercent: 5,
            label: 'flowz-stats',
            peakMemoryMb: 2200,
            creationTime: Date.UTC(2026, 6, 2, 8, 0, 0),
          },
        ],
      },
    });
    expect(md).toContain('| 类型 | PID | 内存(MB) | 峰值(MB) | CPU(%) | 标识 | 创建时刻 |');
    expect(md).toContain(
      `| Utility | 100 | 2048 | 2200 | 5 | flowz-stats | ${new Date(Date.UTC(2026, 6, 2, 8, 0, 0)).toISOString()} |`
    );
  });

  it('渲染进程堆分层：可用时逐字段渲染', () => {
    const md = buildDiagnosticReport({
      ...base,
      rendererHeap: {
        usedHeapMb: 120,
        totalHeapMb: 180,
        heapLimitMb: 4096,
        residentSetMb: 2200,
        blinkResourceMb: 64,
      },
    });
    expect(md).toContain('## 渲染进程堆分层');
    expect(md).toContain('- V8 usedHeap：120 MB');
    expect(md).toContain('- 进程 residentSet：2200 MB');
    expect(md).toContain('- Blink 资源缓存(live)：64 MB');
  });

  it('渲染进程堆分层：unavailable 时只渲染原因行', () => {
    const md = buildDiagnosticReport({
      ...base,
      rendererHeap: { unavailable: 'unavailable（渲染进程内省超时 >2000ms，疑窗口卡死）' },
    });
    expect(md).toContain('## 渲染进程堆分层');
    expect(md).toContain('内省超时');
    expect(md).not.toContain('V8 usedHeap');
  });

  it('sing-box 核进程：可用渲染 PID/RSS/CPU；unavailable 渲染原因', () => {
    const ok = buildDiagnosticReport({
      ...base,
      coreProcess: { pid: 374000, rssMb: 180, cpuPercent: 53 },
    });
    expect(ok).toContain('## sing-box 核进程');
    expect(ok).toContain('PID 374000：RSS 180 MB，CPU 53%');

    const na = buildDiagnosticReport({
      ...base,
      coreProcess: { unavailable: 'unavailable（代理未运行）' },
    });
    expect(na).toContain('unavailable（代理未运行）');
  });

  it('内存时间线：CSV 以代码块承载', () => {
    const md = buildDiagnosticReport({
      ...base,
      memoryTimelineCsv: 't,label,pid,rssMb\n2026-07-02T00:00:00.000Z,Browser,100,300',
    });
    expect(md).toContain('## 内存时间线');
    expect(md).toContain('```csv');
    expect(md).toContain('2026-07-02T00:00:00.000Z,Browser,100,300');
  });

  it('渲染进程内存看护：阈值 + discard/warn 计数逐行渲染（issue #242 §4）', () => {
    const md = buildDiagnosticReport({
      ...base,
      rendererWatchdog: { discardCount: 2, warnCount: 3, thresholdMb: 1536 },
    });
    expect(md).toContain('## 渲染进程内存看护');
    expect(md).toContain('- 阈值：1536 MB');
    expect(md).toContain('- 隐藏态回收（discard）：2 次');
    expect(md).toContain('- 可见态告警（warn）：3 次');
  });

  it('全部新字段缺省 → 不渲染任何观测新区块（向后兼容）', () => {
    const md = buildDiagnosticReport(base);
    expect(md).not.toContain('## 渲染进程堆分层');
    expect(md).not.toContain('## sing-box 核进程');
    expect(md).not.toContain('## 内存时间线');
    expect(md).not.toContain('## 渲染进程内存看护');
  });
});

describe('collectNodeIdentifiers — 节点标识符提取 + 类型化占位（P0.6）', () => {
  it('地址/SNI/Host/ShadowTLS-sni/Tailscale/custom outbound/节点名 全覆盖，类型化占位、去重、节点名跳过<4', () => {
    const ids = collectNodeIdentifiers({
      servers: [
        {
          address: 'a.example-argo.com',
          name: '香港机场A',
          tlsSettings: { serverName: 'sni.real.net' },
          wsSettings: { headers: { Host: 'host.argo.dev' } },
        },
        { address: '104.18.8.83', name: 'US' }, // name 'US' <4 跳过
        { shadowTlsSettings: { sni: 'disguise.shadow.io' } }, // H2: ShadowTLS sni
        { tailscaleSettings: { hostname: 'mybox.ts.net', exitNode: 'exit.ts.net' } }, // H2: tailscale
        {
          customSettings: {
            outbound: { type: 'snell', server: 'custom.node.io', sni: 'cust.sni.io' },
          },
        }, // H2: custom 展平
        { address: 'a.example-argo.com' }, // 重复 → 不再分配
      ],
    });
    const map = Object.fromEntries(ids.map((i) => [i.value, i.placeholder]));
    expect(map['a.example-argo.com']).toBe('<domain-1>');
    expect(map['sni.real.net']).toBe('<domain-2>');
    expect(map['host.argo.dev']).toBe('<domain-3>');
    expect(map['104.18.8.83']).toBe('<ip-1>');
    expect(map['disguise.shadow.io']).toBeDefined(); // H2 ShadowTLS sni 已采集
    expect(map['mybox.ts.net']).toBeDefined(); // H2 tailscale hostname
    expect(map['exit.ts.net']).toBeDefined(); // H2 tailscale exitNode
    expect(map['custom.node.io']).toBeDefined(); // H2 custom outbound server
    expect(map['cust.sni.io']).toBeDefined(); // H2 custom outbound sni
    expect(map['香港机场A']).toBe('<node-1>');
    expect(map['US']).toBeUndefined();
    expect(ids.filter((i) => i.value === 'a.example-argo.com')).toHaveLength(1);
  });

  it('空 / 无 servers → 空', () => {
    expect(collectNodeIdentifiers(null)).toEqual([]);
    expect(collectNodeIdentifiers({})).toEqual([]);
  });

  it('MED-1：custom 透传 outbound 的嵌套主机字段(tls.server_name / transport.headers.Host)也被收集', () => {
    const ids = collectNodeIdentifiers({
      servers: [
        {
          customSettings: {
            outbound: {
              type: 'vless',
              server: 'node.real.io',
              tls: { server_name: 'hidden.sni.com' },
              transport: { headers: { Host: 'ws.host.com' } },
            },
          },
        },
      ],
    });
    const vals = ids.map((i) => i.value);
    expect(vals).toContain('node.real.io');
    expect(vals).toContain('hidden.sni.com'); // 嵌套 tls.server_name
    expect(vals).toContain('ws.host.com'); // 嵌套 transport.headers.Host
  });

  it('LOW-1：WS headers 小写 host 也被收集(JSON 导入非规范键)', () => {
    const ids = collectNodeIdentifiers({
      servers: [{ wsSettings: { headers: { host: 'lower.host.io' } } }],
    });
    expect(ids.map((i) => i.value)).toContain('lower.host.io');
  });

  it('HTTP transport headers.Host（值为 string[]，与 ws 分支对称）也被收集', () => {
    const ids = collectNodeIdentifiers({
      servers: [{ httpSettings: { headers: { Host: ['masq.http.io'] } } }],
    });
    expect(ids.map((i) => i.value)).toContain('masq.http.io');
  });

  it('looksLikeIp 收敛 isIpv4：超界段 999.1.1.1 归域名而非 IP（不再被宽松正则误判）', () => {
    const ids = collectNodeIdentifiers({ servers: [{ address: '999.1.1.1' }] });
    expect(ids).toHaveLength(1);
    expect(ids[0].placeholder).toBe('<domain-1>');
  });

  it('#57 resolve-ahead：extraAddresses（预解析节点 IP）按 <ip-N> 一并收集、去重', () => {
    const ids = collectNodeIdentifiers(
      { servers: [{ address: 'hk.airport.com' }] }, // 域名 → <domain-1>
      ['203.0.113.55', '203.0.113.55', '198.51.100.9'] // 预解析 IP（含重复）
    );
    const map = Object.fromEntries(ids.map((i) => [i.value, i.placeholder]));
    expect(map['hk.airport.com']).toBe('<domain-1>');
    expect(map['203.0.113.55']).toBe('<ip-1>');
    expect(map['198.51.100.9']).toBe('<ip-2>');
    expect(ids).toHaveLength(3); // 重复 IP 去重
  });

  it('#57：预解析 IP 经 redactIdentifiers 在配置文本里被打码（杜绝真实节点 IP 明文泄漏）', () => {
    const ids = collectNodeIdentifiers({ servers: [{ address: 'hk.airport.com' }] }, [
      '203.0.113.55',
    ]);
    // 模拟报告里 outbound.server 已是预解析 IP 的配置 JSON 片段
    const cfgText = '"server": "203.0.113.55",\n"tls": { "server_name": "hk.airport.com" }';
    const out = redactIdentifiers(cfgText, ids);
    expect(out).not.toContain('203.0.113.55'); // IP 被打码
    expect(out).toContain('<ip-1>');
    expect(out).toContain('<domain-1>'); // SNI 域名仍按域名打码
  });
});

describe('redactIdentifiers — 文本统一打码 + 主机边界锚定（P0.6 / H1）', () => {
  const ids = [
    { value: 'a.example-argo.com', placeholder: '<domain-1>' },
    { value: '104.18.8.83', placeholder: '<ip-1>' },
  ];
  it('日志里节点域名/IP 被替换为占位（大小写不敏感）', () => {
    const log = 'lookup A.Example-Argo.com: SERVFAIL\noutbound to 104.18.8.83:443';
    expect(redactIdentifiers(log, ids)).toBe('lookup <domain-1>: SERVFAIL\noutbound to <ip-1>:443');
  });
  it('H1 边界：节点标识符作子串不误替无关串（cdn.a... 不动、104.18.8.831 不切）', () => {
    const text = 'visit cdn.a.example-argo.com and 104.18.8.831';
    expect(redactIdentifiers(text, ids)).toBe(text);
  });
  it('长值优先：避免子串先替坏长值', () => {
    const out = redactIdentifiers('x.example-argo.com', [
      { value: 'example-argo.com', placeholder: '<domain-2>' },
      { value: 'x.example-argo.com', placeholder: '<domain-1>' },
    ]);
    expect(out).toBe('<domain-1>');
  });
  it('空文本 / 空 ids → 原样', () => {
    expect(redactIdentifiers('', ids)).toBe('');
    expect(redactIdentifiers('abc', [])).toBe('abc');
  });
});

describe('buildDiagnosticReport × P0.6：末尾统一打码节点标识符（配置块 + 日志一致）', () => {
  const input: DiagnosticReportInput = {
    generatedAt: '2026-06-17T00:00:00.000Z',
    app: { flowzVersion: '1', coreVersion: '1.13', os: 'win32' },
    runtime: {
      proxyMode: 'smart',
      proxyModeType: 'tun',
      proxyRunning: true,
      nodeDomainResolver: 'auto',
      logLevel: 'info',
      captureActive: false,
    },
    redactedUserConfig: { servers: [{ address: 'a.example-argo.com' }] },
    redactedSingboxConfig: { outbounds: [{ server: 'a.example-argo.com' }] },
    appLogTail: 'lookup a.example-argo.com: SERVFAIL',
    singboxLogTail: '',
    nodeIdentifiers: [{ value: 'a.example-argo.com', placeholder: '<domain-1>' }],
  };
  it('配置块与日志中的节点域名均替换为同一占位（可关联、不泄漏值）', () => {
    const md = buildDiagnosticReport(input);
    expect(md).not.toContain('a.example-argo.com');
    expect(md).toContain('<domain-1>');
    expect(md).toContain('lookup <domain-1>: SERVFAIL');
  });
  it('无 nodeIdentifiers → 不改动（向后兼容）', () => {
    const md = buildDiagnosticReport({ ...input, nodeIdentifiers: undefined });
    expect(md).toContain('a.example-argo.com');
  });
});
