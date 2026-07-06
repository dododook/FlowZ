/**
 * ClashSubscriptionParser 单测（node env，零网络零 electron）。
 * 覆盖 doc「验证」节用例：协议映射 / CDN 三落点 / 指纹 parity / ss plugin / provider 编排 /
 * filter+exclude / 非法正则 / type:file / 超时与部分失败 / 去重 / override / maxProviders 截断。
 */
import { dump as yamlDump } from 'js-yaml';
import {
  CLASH_PROBE_RE,
  tryLoadClashDoc,
  parseClashProxies,
  resolveProxyProviders,
  compileProviderFilter,
  applyProviderFilters,
  applyOverride,
  MAX_FILTER_PATTERN_LEN,
  MAX_FILTER_NAME_LEN,
  type ProviderDeps,
  type ClashParseResult,
} from '../ClashSubscriptionParser';
import { ProtocolParser } from '../ProtocolParser';
import { normalizeDuration } from '../../../shared/duration';
import type { ServerConfig } from '../../../shared/types';

const SUB_ID = 'sub-test';
const NOW = '2026-06-12T00:00:00.000Z';

/** 指纹四元组（镜像 SubscriptionService.serverFingerprint 的凭据落点，不引入 electron 依赖）。 */
function fourTuple(s: ServerConfig): [string, string, number, string] {
  const cred =
    s.uuid ||
    s.password ||
    s.shadowsocksSettings?.password ||
    s.username ||
    s.sshSettings?.password ||
    '';
  return [(s.protocol || '').toLowerCase(), s.address, s.port, cred];
}

function byName(servers: ServerConfig[], name: string): ServerConfig {
  const s = servers.find((x) => x.name === name);
  if (!s) throw new Error(`节点未找到: ${name}（实际: ${servers.map((x) => x.name).join(',')}）`);
  return s;
}

/** 把 proxies 数组包成 Clash YAML 文本。 */
function clashYaml(proxies: unknown[], extra: Record<string, unknown> = {}): string {
  return yamlDump({ proxies, ...extra });
}

describe('探测正则 CLASH_PROBE_RE', () => {
  it('命中 proxies: 与 proxy-providers:', () => {
    expect(CLASH_PROBE_RE.test('proxies:\n  - {}')).toBe(true);
    expect(CLASH_PROBE_RE.test('proxy-providers:\n  a: {}')).toBe(true);
    expect(CLASH_PROBE_RE.test('mixed-port: 7890\nproxies:\n  - {}')).toBe(true);
  });
  it('不误命中纯 base64 / sing-box JSON', () => {
    expect(CLASH_PROBE_RE.test('dmxlc3M6Ly8=')).toBe(false);
    expect(CLASH_PROBE_RE.test('{"outbounds":[]}')).toBe(false);
  });
});

describe('tryLoadClashDoc', () => {
  it('json:true 容忍重复 key（取后者）', () => {
    const doc = tryLoadClashDoc('proxies:\n  - {name: a, server: x, port: 1}\ndup: 1\ndup: 2');
    expect((doc as any).dup).toBe(2);
  });
  it('解析失败上抛（不静默吞）', () => {
    expect(() => tryLoadClashDoc('proxies:\n  - {a: : :}')).toThrow(/Clash YAML 解析失败/);
  });
});

describe('parseClashProxies — 协议映射', () => {
  it('vless + reality', () => {
    const { servers } = parseClashProxies(
      [
        {
          name: 'vless-reality',
          type: 'vless',
          server: '1.2.3.4',
          port: 443,
          uuid: 'uuid-1',
          flow: 'xtls-rprx-vision',
          tls: true,
          servername: 'www.example.com',
          'reality-opts': { 'public-key': 'PUBKEY', 'short-id': 'abcd' },
          'client-fingerprint': 'chrome',
        },
      ],
      SUB_ID,
      NOW
    );
    const s = servers[0];
    expect(s.protocol).toBe('vless');
    expect(s.uuid).toBe('uuid-1');
    expect(s.flow).toBe('xtls-rprx-vision');
    expect(s.security).toBe('reality');
    expect(s.realitySettings).toEqual({ publicKey: 'PUBKEY', shortId: 'abcd' });
    expect(s.tlsSettings?.serverName).toBe('www.example.com');
    expect(s.tlsSettings?.fingerprint).toBe('chrome');
    expect(s.encryption).toBe('none');
  });

  it('vless + ws + CDN（server=优选IP, servername=cdn, Host=cdn）三落点互不错位', () => {
    const { servers } = parseClashProxies(
      [
        {
          name: 'vless-cdn',
          type: 'vless',
          server: '104.16.0.1', // 优选 IP（连接目标）
          port: 443,
          uuid: 'uuid-cdn',
          tls: true,
          servername: 'sni.cdn.com', // SNI 专用
          network: 'ws',
          'ws-opts': { path: '/ws', headers: { Host: 'host.cdn.com' } }, // 伪装 Host
        },
      ],
      SUB_ID,
      NOW
    );
    const s = servers[0];
    expect(s.address).toBe('104.16.0.1'); // server → address，绝不被覆盖
    expect(s.tlsSettings?.serverName).toBe('sni.cdn.com'); // servername → SNI
    expect(s.wsSettings?.headers?.Host).toBe('host.cdn.com'); // ws Host → wsSettings.headers.Host
    expect(s.wsSettings?.path).toBe('/ws');
    // 三者两两不等，确认不错位
    expect(s.address).not.toBe(s.tlsSettings?.serverName);
    expect(s.tlsSettings?.serverName).not.toBe(s.wsSettings?.headers?.Host);
  });

  it('ws Host header 大小写不敏感', () => {
    const { servers } = parseClashProxies(
      [
        {
          name: 'ci-host',
          type: 'vless',
          server: '1.1.1.1',
          port: 443,
          uuid: 'u',
          tls: true,
          servername: 'sni.com',
          network: 'ws',
          'ws-opts': { headers: { HOST: 'lower.cdn.com' } },
        },
      ],
      SUB_ID,
      NOW
    );
    expect(servers[0].wsSettings?.headers?.Host).toBe('lower.cdn.com');
  });

  it('vmess + ws', () => {
    const { servers } = parseClashProxies(
      [
        {
          name: 'vmess-ws',
          type: 'vmess',
          server: '2.2.2.2',
          port: 80,
          uuid: 'vm-uuid',
          alterId: 0,
          cipher: 'auto',
          network: 'ws',
          'ws-opts': { path: '/vm' },
        },
      ],
      SUB_ID,
      NOW
    );
    const s = servers[0];
    expect(s.protocol).toBe('vmess');
    expect(s.uuid).toBe('vm-uuid');
    expect(s.alterId).toBe(0);
    expect(s.vmessSecurity).toBe('auto');
    expect(s.wsSettings?.path).toBe('/vm');
  });

  it('trojan（恒 TLS）', () => {
    const { servers } = parseClashProxies(
      [{ name: 'tj', type: 'trojan', server: '3.3.3.3', port: 443, password: 'pw', sni: 'tj.com' }],
      SUB_ID,
      NOW
    );
    const s = servers[0];
    expect(s.protocol).toBe('trojan');
    expect(s.password).toBe('pw');
    expect(s.security).toBe('tls');
    expect(s.tlsSettings?.serverName).toBe('tj.com');
  });

  it('ss 裸 + 数字 password 被 String 化（落 shadowsocksSettings.password，不写顶层）', () => {
    const { servers } = parseClashProxies(
      [
        {
          name: 'ss',
          type: 'ss',
          server: '4.4.4.4',
          port: 8388,
          cipher: 'aes-256-gcm',
          password: 12345,
        },
      ],
      SUB_ID,
      NOW
    );
    const s = servers[0];
    expect(s.protocol).toBe('shadowsocks');
    expect(s.shadowsocksSettings?.method).toBe('aes-256-gcm');
    expect(s.shadowsocksSettings?.password).toBe('12345'); // 数字 → 字符串
    expect(s.password).toBeUndefined(); // 不写顶层
  });

  it('ss + obfs plugin → obfs-local', () => {
    const { servers } = parseClashProxies(
      [
        {
          name: 'ss-obfs',
          type: 'ss',
          server: '5.5.5.5',
          port: 443,
          cipher: 'aes-128-gcm',
          password: 'p',
          plugin: 'obfs',
          'plugin-opts': { mode: 'tls', host: 'obfs.cdn.com' },
        },
      ],
      SUB_ID,
      NOW
    );
    const s = servers[0];
    expect(s.shadowsocksSettings?.plugin).toBe('obfs-local');
    expect(s.shadowsocksSettings?.pluginOptions).toBe('obfs=tls;obfs-host=obfs.cdn.com');
  });

  it('ss + 未知 plugin（restls）整节点跳过 + 计数告警', () => {
    const r = parseClashProxies(
      [
        {
          name: 'ss-restls',
          type: 'ss',
          server: '6.6.6.6',
          port: 443,
          cipher: 'x',
          password: 'p',
          plugin: 'restls',
        },
      ],
      SUB_ID,
      NOW
    );
    expect(r.servers).toHaveLength(0);
    expect(r.skipped).toBe(1);
    expect(r.warnings.some((w) => /ss-plugin:restls/.test(w))).toBe(true);
  });

  it('hy2（ports 段 + obfs + up/down）', () => {
    const { servers } = parseClashProxies(
      [
        {
          name: 'hy2',
          type: 'hysteria2',
          server: '7.7.7.7',
          port: 20000,
          password: 'hp',
          ports: '20000-30000,40000-50000',
          obfs: 'salamander',
          'obfs-password': 'obfspw',
          up: 50,
          down: 200,
          sni: 'hy2.com',
          'hop-interval': 30,
        },
      ],
      SUB_ID,
      NOW
    );
    const s = servers[0];
    expect(s.protocol).toBe('hysteria2');
    expect(s.security).toBe('tls');
    expect(s.hysteria2Settings?.serverPorts).toBe('20000:30000,40000:50000');
    expect(s.hysteria2Settings?.obfs).toEqual({ type: 'salamander', password: 'obfspw' });
    expect(s.hysteria2Settings?.upMbps).toBe(50);
    expect(s.hysteria2Settings?.downMbps).toBe(200);
    expect(s.hysteria2Settings?.hopInterval).toBe('30s');
    expect(s.tlsSettings?.serverName).toBe('hy2.com');
  });

  it('收编协议 tuic/anytls/socks5/http/ssh', () => {
    const { servers } = parseClashProxies(
      [
        {
          name: 'tuic',
          type: 'tuic',
          server: '8.8.8.8',
          port: 443,
          uuid: 'tu',
          password: 'tp',
          sni: 't.com',
        },
        {
          name: 'anytls',
          type: 'anytls',
          server: '9.9.9.9',
          port: 443,
          password: 'ap',
          sni: 'a.com',
        },
        {
          name: 'socks',
          type: 'socks5',
          server: '10.0.0.1',
          port: 1080,
          username: 'su',
          password: 'sp',
        },
        {
          name: 'http',
          type: 'http',
          server: '10.0.0.2',
          port: 8080,
          username: 'hu',
          password: 'hp',
        },
        {
          name: 'ssh',
          type: 'ssh',
          server: '10.0.0.3',
          port: 22,
          username: 'root',
          password: 'sshpw',
        },
      ],
      SUB_ID,
      NOW
    );
    expect(servers.map((s) => s.protocol).sort()).toEqual(
      ['anytls', 'http', 'socks', 'ssh', 'tuic'].sort()
    );
    const tuic = byName(servers, 'tuic');
    expect(tuic.uuid).toBe('tu');
    expect(tuic.password).toBe('tp');
    expect(tuic.security).toBe('tls');
    const socks = byName(servers, 'socks');
    expect(socks.protocol).toBe('socks');
    expect(socks.username).toBe('su');
    const ssh = byName(servers, 'ssh');
    expect(ssh.sshSettings?.password).toBe('sshpw');
    expect(ssh.sshSettings?.user).toBe('root');
  });

  // 收敛面回填：anytls idle 三件套 + ssh client-version 此前 mapNode 不读 → 订阅导入丢字段。
  it('anytls 读 idle 三件套（连字符 key + 毫秒整数规整 ms）', () => {
    const { servers } = parseClashProxies(
      [
        {
          name: 'anytls',
          type: 'anytls',
          server: '9.9.9.9',
          port: 443,
          password: 'ap',
          sni: 'a.com',
          'idle-session-check-interval': 30000,
          'idle-session-timeout': '60s',
          'min-idle-session': 5,
        },
      ],
      SUB_ID,
      NOW
    );
    const at = byName(servers, 'anytls').anyTlsSettings;
    expect(at?.idleSessionCheckInterval).toBe('30000ms'); // 裸毫秒整数补单位
    expect(at?.idleSessionTimeout).toBe('60s'); // 已带单位透传
    expect(at?.minIdleSession).toBe(5);
  });

  it('anytls 无 idle 字段 → anyTlsSettings 不被臆造', () => {
    const { servers } = parseClashProxies(
      [{ name: 'anytls', type: 'anytls', server: '9.9.9.9', port: 443, password: 'ap' }],
      SUB_ID,
      NOW
    );
    expect(byName(servers, 'anytls').anyTlsSettings).toBeUndefined();
  });

  it('ssh 读 client-version（有值才写，守卫式）', () => {
    const { servers } = parseClashProxies(
      [
        {
          name: 'ssh',
          type: 'ssh',
          server: '10.0.0.3',
          port: 22,
          username: 'root',
          password: 'sshpw',
          'client-version': 'SSH-2.0-OpenSSH_9.0',
        },
      ],
      SUB_ID,
      NOW
    );
    expect(byName(servers, 'ssh').sshSettings?.clientVersion).toBe('SSH-2.0-OpenSSH_9.0');
  });

  it('不支持类型聚合告警（ssr/wireguard），不整批失败', () => {
    const r = parseClashProxies(
      [
        { name: 'a', type: 'vless', server: '1.1.1.1', port: 443, uuid: 'u' },
        { name: 'b', type: 'ssr', server: '2.2.2.2', port: 443 },
        { name: 'c', type: 'wireguard', server: '3.3.3.3', port: 443 },
      ],
      SUB_ID,
      NOW
    );
    expect(r.servers).toHaveLength(1);
    expect(r.skipped).toBe(2);
    expect(r.warnings[0]).toMatch(/ssr\(1\)/);
    expect(r.warnings[0]).toMatch(/wireguard\(1\)/);
  });

  it('缺 server/port 的坏节点 → failed + 告警，不抛', () => {
    const r = parseClashProxies(
      [
        { name: 'good', type: 'vless', server: '1.1.1.1', port: 443, uuid: 'u' },
        { name: 'noserver', type: 'vless', port: 443, uuid: 'u' },
      ],
      SUB_ID,
      NOW
    );
    expect(r.servers).toHaveLength(1);
    expect(r.failed).toBe(1);
    expect(r.warnings.some((w) => /解析失败/.test(w))).toBe(true);
  });
});

describe('指纹 parity — Clash 节点 vs ProtocolParser.parseUrl 四元组全等', () => {
  const parser = new ProtocolParser();

  it('vless', () => {
    const clash = parseClashProxies(
      [
        {
          name: 'p',
          type: 'vless',
          server: '1.2.3.4',
          port: 443,
          uuid: 'U-1',
          tls: true,
          servername: 's.com',
        },
      ],
      SUB_ID,
      NOW
    ).servers[0];
    const url = parser.parseUrl('vless://U-1@1.2.3.4:443?encryption=none&security=tls&sni=s.com#p');
    expect(fourTuple(clash)).toEqual(fourTuple(url));
  });

  it('trojan', () => {
    const clash = parseClashProxies(
      [{ name: 'p', type: 'trojan', server: '5.6.7.8', port: 443, password: 'PW' }],
      SUB_ID,
      NOW
    ).servers[0];
    const url = parser.parseUrl('trojan://PW@5.6.7.8:443#p');
    expect(fourTuple(clash)).toEqual(fourTuple(url));
  });

  it('shadowsocks（凭据落 shadowsocksSettings.password）', () => {
    const clash = parseClashProxies(
      [
        {
          name: 'p',
          type: 'ss',
          server: '9.9.9.9',
          port: 8388,
          cipher: 'aes-256-gcm',
          password: 'SSPW',
        },
      ],
      SUB_ID,
      NOW
    ).servers[0];
    const url = parser.parseUrl('ss://aes-256-gcm:SSPW@9.9.9.9:8388#p');
    expect(fourTuple(clash)).toEqual(fourTuple(url));
  });

  it('hysteria2', () => {
    const clash = parseClashProxies(
      [
        {
          name: 'p',
          type: 'hysteria2',
          server: '7.7.7.7',
          port: 443,
          password: 'HP',
          sni: 'h.com',
        },
      ],
      SUB_ID,
      NOW
    ).servers[0];
    const url = parser.parseUrl('hysteria2://HP@7.7.7.7:443?sni=h.com#p');
    expect(fourTuple(clash)).toEqual(fourTuple(url));
  });

  it('tuic', () => {
    const clash = parseClashProxies(
      [
        {
          name: 'p',
          type: 'tuic',
          server: '8.8.8.8',
          port: 443,
          uuid: 'TU',
          password: 'TP',
          sni: 't.com',
        },
      ],
      SUB_ID,
      NOW
    ).servers[0];
    const url = parser.parseUrl('tuic://TU:TP@8.8.8.8:443?sni=t.com#p');
    expect(fourTuple(clash)).toEqual(fourTuple(url));
  });

  it('socks5', () => {
    const clash = parseClashProxies(
      [
        {
          name: 'p',
          type: 'socks5',
          server: '10.0.0.1',
          port: 1080,
          username: 'SU',
          password: 'SP',
        },
      ],
      SUB_ID,
      NOW
    ).servers[0];
    const url = parser.parseUrl('socks5://SU:SP@10.0.0.1:1080#p');
    expect(fourTuple(clash)).toEqual(fourTuple(url));
  });
});

describe('filter / exclude-filter / 非法正则', () => {
  const named = (names: string[]) => names.map((name) => ({ name }));
  const warns: string[] = [];
  beforeEach(() => (warns.length = 0));

  it('filter 保留 + exclude 剔除（顺序对齐 mihomo）', () => {
    const res = applyProviderFilters(
      named(['HK-01', 'US-02', 'HK-Trial', 'JP-03']),
      'HK|US',
      'Trial',
      (m) => warns.push(m),
      'prov'
    ) as Array<{ name: string }>;
    expect(res.map((x) => x.name)).toEqual(['HK-01', 'US-02']);
  });

  it('大小写敏感（不加 i 标志）', () => {
    const res = applyProviderFilters(named(['HK', 'hk']), 'HK', undefined, () => {}, 'p') as Array<{
      name: string;
    }>;
    expect(res.map((x) => x.name)).toEqual(['HK']);
  });

  it('emoji 匹配', () => {
    const res = applyProviderFilters(
      named(['🇭🇰 香港', '🇺🇸 美国']),
      '🇭🇰',
      undefined,
      () => {},
      'p'
    ) as Array<{
      name: string;
    }>;
    expect(res.map((x) => x.name)).toEqual(['🇭🇰 香港']);
  });

  it('非法正则 → 跳过该 filter + warn，不整批失败', () => {
    const res = applyProviderFilters(
      named(['a', 'b']),
      '[invalid(',
      undefined,
      (m) => warns.push(m),
      'prov'
    ) as Array<{
      name: string;
    }>;
    expect(res).toHaveLength(2); // 未过滤
    expect(warns.some((w) => /非法或超长正则|非法正则/.test(w))).toBe(true);
    expect(compileProviderFilter('[invalid(')).toBeNull();
  });
});

describe('applyOverride — 白名单 3 键', () => {
  it('skip-cert-verify → allowInsecure；up/down → hy2 限速', () => {
    const servers: ServerConfig[] = [
      // security: 'tls' 使该 vless 成为 TLS 节点，才有资格注入 tlsSettings
      {
        id: '1',
        name: 'a',
        protocol: 'vless',
        address: 'x',
        port: 1,
        uuid: 'u',
        security: 'tls',
      },
      {
        id: '2',
        name: 'b',
        protocol: 'hysteria2',
        address: 'y',
        port: 2,
        password: 'p',
        // hysteria2 协议恒 TLS（与现实 parseHysteria2 产出一致）
        security: 'tls',
      },
    ];
    applyOverride(servers, { 'skip-cert-verify': true, up: 100, down: 500, 'not-allowed': 'x' });
    expect(servers[0].tlsSettings?.allowInsecure).toBe(true);
    expect(servers[1].tlsSettings?.allowInsecure).toBe(true);
    expect(servers[1].hysteria2Settings?.upMbps).toBe(100);
    expect(servers[1].hysteria2Settings?.downMbps).toBe(500);
    // 非白名单键不进入 config（无 not-allowed 落点）
    expect((servers[0] as any)['not-allowed']).toBeUndefined();
  });
});

describe('B-m2 applyOverride — 非 TLS 节点不注入空 tlsSettings（指纹噪音）', () => {
  it('非 TLS 节点（裸 vless，security 缺省）→ 不注入 tlsSettings', () => {
    const servers: ServerConfig[] = [
      { id: '1', name: 'plain-vless', protocol: 'vless', address: 'x', port: 1, uuid: 'u' },
    ];
    applyOverride(servers, { 'skip-cert-verify': true });
    // 关键断言：非 TLS 节点不应被注入空/仅含 allowInsecure 的 tlsSettings（否则暴露代理特征）
    expect(servers[0].tlsSettings).toBeUndefined();
  });

  it('security=none 节点（vmess 无 tls）→ 不注入 tlsSettings', () => {
    const servers: ServerConfig[] = [
      {
        id: '2',
        name: 'vmess-notls',
        protocol: 'vmess',
        address: 'x',
        port: 80,
        uuid: 'u',
        security: 'none',
      },
    ];
    applyOverride(servers, { 'skip-cert-verify': true });
    expect(servers[0].tlsSettings).toBeUndefined();
  });

  it('非 TLS 协议族（ss/socks/http/ssh）→ 均不注入 tlsSettings', () => {
    const servers: ServerConfig[] = [
      {
        id: 'ss',
        name: 'ss',
        protocol: 'shadowsocks',
        address: 'a',
        port: 1,
        shadowsocksSettings: { method: 'aes-256-gcm', password: 'p' },
      },
      { id: 'socks', name: 'socks', protocol: 'socks', address: 'b', port: 2, username: 'u' },
      { id: 'http', name: 'http', protocol: 'http', address: 'c', port: 3, username: 'u' },
      {
        id: 'ssh',
        name: 'ssh',
        protocol: 'ssh',
        address: 'd',
        port: 4,
        sshSettings: { user: 'root', password: 'p' },
      },
    ];
    applyOverride(servers, { 'skip-cert-verify': false });
    for (const s of servers) {
      expect(s.tlsSettings).toBeUndefined();
    }
  });

  it('TLS 节点（security=tls）→ 正确合并 allowInsecure，保留既有 serverName', () => {
    const servers: ServerConfig[] = [
      {
        id: '1',
        name: 'vless-tls',
        protocol: 'vless',
        address: 'x',
        port: 443,
        uuid: 'u',
        security: 'tls',
        tlsSettings: { serverName: 'sni.example.com', fingerprint: 'chrome' },
      },
    ];
    applyOverride(servers, { 'skip-cert-verify': true });
    expect(servers[0].tlsSettings).toEqual({
      serverName: 'sni.example.com',
      fingerprint: 'chrome',
      allowInsecure: true,
    });
  });

  it('reality 节点（security=reality）→ 注入 allowInsecure（复用 TLS 传输层）', () => {
    const servers: ServerConfig[] = [
      {
        id: '1',
        name: 'vless-reality',
        protocol: 'vless',
        address: 'x',
        port: 443,
        uuid: 'u',
        security: 'reality',
        realitySettings: { publicKey: 'PUB' },
      },
    ];
    applyOverride(servers, { 'skip-cert-verify': true });
    expect(servers[0].tlsSettings?.allowInsecure).toBe(true);
  });

  it('恒 TLS 协议（hysteria2/trojan/tuic/anytls）→ 正确注入 allowInsecure', () => {
    const servers: ServerConfig[] = [
      {
        id: 'hy2',
        name: 'hy2',
        protocol: 'hysteria2',
        address: 'a',
        port: 1,
        password: 'p',
        security: 'tls',
      },
      {
        id: 'tj',
        name: 'tj',
        protocol: 'trojan',
        address: 'b',
        port: 2,
        password: 'p',
        security: 'tls',
      },
      {
        id: 'tuic',
        name: 'tuic',
        protocol: 'tuic',
        address: 'c',
        port: 3,
        uuid: 'u',
        password: 'p',
        security: 'tls',
      },
      {
        id: 'anytls',
        name: 'anytls',
        protocol: 'anytls',
        address: 'd',
        port: 4,
        password: 'p',
        security: 'tls',
      },
    ];
    applyOverride(servers, { 'skip-cert-verify': false });
    for (const s of servers) {
      expect(s.tlsSettings?.allowInsecure).toBe(false);
    }
  });

  it('兼容：未写 security 但已带 tlsSettings 的存量节点 → 仍合并 allowInsecure', () => {
    // 存量/手动节点可能省略 security 但携带 tlsSettings，此时不应因 security 缺省而漏注入。
    const servers: ServerConfig[] = [
      {
        id: '1',
        name: 'legacy',
        protocol: 'vless',
        address: 'x',
        port: 443,
        uuid: 'u',
        tlsSettings: { serverName: 'sni.example.com' },
      },
    ];
    applyOverride(servers, { 'skip-cert-verify': true });
    expect(servers[0].tlsSettings?.allowInsecure).toBe(true);
    expect(servers[0].tlsSettings?.serverName).toBe('sni.example.com');
  });

  it('未给 skip-cert-verify → TLS 节点既有 tlsSettings 原样不动', () => {
    const servers: ServerConfig[] = [
      {
        id: '1',
        name: 'vless-tls',
        protocol: 'vless',
        address: 'x',
        port: 443,
        uuid: 'u',
        security: 'tls',
        tlsSettings: { serverName: 'sni.example.com' },
      },
    ];
    applyOverride(servers, { up: 100 });
    expect(servers[0].tlsSettings).toEqual({ serverName: 'sni.example.com' });
  });
});

describe('resolveProxyProviders — 编排', () => {
  const baseDeps = (
    fetchText: ProviderDeps['fetchText'],
    parseContent?: ProviderDeps['parseContent']
  ): ProviderDeps => ({
    fetchText,
    parseContent:
      parseContent ??
      (async (text: string): Promise<ClashParseResult> => {
        const doc = tryLoadClashDoc(text);
        return parseClashProxies(doc.proxies, SUB_ID, NOW);
      }),
    log: () => {},
    subscriptionId: SUB_ID,
    now: NOW,
    maxProviders: 8,
    fetchTimeoutMs: 100,
  });

  it('纯 provider 合并（多 provider 全并行，按声明序拼接）', async () => {
    const fetchText = async (url: string) => {
      if (url.includes('p1'))
        return clashYaml([{ name: 'n1', type: 'vless', server: '1.1.1.1', port: 1, uuid: 'a' }]);
      return clashYaml([{ name: 'n2', type: 'vless', server: '2.2.2.2', port: 2, uuid: 'b' }]);
    };
    const r = await resolveProxyProviders(
      { p1: { type: 'http', url: 'http://x/p1' }, p2: { type: 'http', url: 'http://x/p2' } },
      baseDeps(fetchText)
    );
    expect(r.servers.map((s) => s.name)).toEqual(['n1', 'n2']);
    expect(r.succeeded).toBe(2);
    expect(r.anyFailed).toBe(false);
    // M1：成功 provider 的节点带归属 providerName（= provider key），失败列表空。
    expect(r.servers.map((s) => s.providerName)).toEqual(['p1', 'p2']);
    expect(r.failedProviders).toEqual([]);
  });

  it('provider 三形态（yaml-proxies / base64 / url-list）全支持', async () => {
    const parseContent = async (text: string): Promise<ClashParseResult> => {
      // 复刻 Service.parseProviderContent 的内联多形态分支（测试侧自给）。
      if (/^proxies\s*:/m.test(text)) {
        return parseClashProxies(tryLoadClashDoc(text).proxies, SUB_ID, NOW);
      }
      const parser = new ProtocolParser();
      let decoded = text;
      if (!decoded.includes('://')) decoded = Buffer.from(decoded, 'base64').toString('utf-8');
      const servers: ServerConfig[] = [];
      for (const line of decoded.split(/\r?\n/).filter((l) => l.trim())) {
        if (parser.isSupported(line)) servers.push(parser.parseUrl(line));
      }
      return { servers, skipped: 0, failed: 0, warnings: [] };
    };
    const urlLine = 'trojan://pw@3.3.3.3:443#url-node';
    const fetchText = async (url: string) => {
      if (url.includes('yaml'))
        return clashYaml([
          { name: 'yaml-node', type: 'vless', server: '1.1.1.1', port: 1, uuid: 'a' },
        ]);
      if (url.includes('b64'))
        return Buffer.from('vless://b@2.2.2.2:2#b64-node').toString('base64');
      return urlLine; // url-list
    };
    const r = await resolveProxyProviders(
      {
        y: { type: 'http', url: 'http://x/yaml' },
        b: { type: 'http', url: 'http://x/b64' },
        u: { type: 'http', url: 'http://x/urls' },
      },
      baseDeps(fetchText, parseContent)
    );
    expect(r.servers.map((s) => s.name).sort()).toEqual(['b64-node', 'url-node', 'yaml-node']);
  });

  it('不递归：provider 内容再含 proxy-providers → 只取内联（由 parseContent allowProviders:false 保证）+ warn', async () => {
    // 这里以 parseContent 仅解析内联 proxies、忽略嵌套 proxy-providers 来体现"不递归"。
    const fetchText = async () =>
      clashYaml([{ name: 'inline-only', type: 'vless', server: '1.1.1.1', port: 1, uuid: 'a' }], {
        'proxy-providers': { nested: { type: 'http', url: 'http://x/nested' } },
      });
    const warnings: string[] = [];
    const deps = baseDeps(fetchText);
    deps.log = (_l, m) => warnings.push(m);
    const r = await resolveProxyProviders({ p: { type: 'http', url: 'http://x/p' } }, deps);
    expect(r.servers.map((s) => s.name)).toEqual(['inline-only']);
  });

  it('type:file 跳过 + 告警（permanent skip，不置 anyFailed）', async () => {
    const fetchText = async () => clashYaml([]);
    const r = await resolveProxyProviders(
      { f: { type: 'file', path: '/etc/passwd' } },
      baseDeps(fetchText)
    );
    expect(r.servers).toHaveLength(0);
    // MED-1：type:file 是 permanent skip（配置面，重试不会变好）→ 仅 warn，不触发 partial。
    expect(r.anyFailed).toBe(false);
    expect(r.warnings.some((w) => /type:file/.test(w) || /file/.test(w))).toBe(true);
  });

  it('MED-1：非 http type / 缺 url / 0 节点 → permanent skip 不置 anyFailed；fetch 失败 → transient 置 anyFailed', async () => {
    // 非 http type（permanent）
    const r1 = await resolveProxyProviders(
      { a: { type: 'inline', payload: 'x' } },
      baseDeps(async () => clashYaml([]))
    );
    expect(r1.anyFailed).toBe(false);

    // 缺 url（permanent）
    const r2 = await resolveProxyProviders(
      { a: { type: 'http' } },
      baseDeps(async () => clashYaml([]))
    );
    expect(r2.anyFailed).toBe(false);

    // HTTP 成功但解析 0 节点（permanent）
    const r3 = await resolveProxyProviders(
      { a: { type: 'http', url: 'http://x/empty' } },
      baseDeps(async () => clashYaml([]))
    );
    expect(r3.servers).toHaveLength(0);
    expect(r3.anyFailed).toBe(false);

    // fetch 抛错（transient）→ 置 anyFailed
    const r4 = await resolveProxyProviders(
      { a: { type: 'http', url: 'http://x/boom' } },
      baseDeps(async () => {
        throw new Error('HTTP Error: 503');
      })
    );
    expect(r4.anyFailed).toBe(true);
  });

  it('单 provider 超时 → 其余正常 + 告警（partial）', async () => {
    const fetchText: ProviderDeps['fetchText'] = async (url, signal) => {
      if (url.includes('slow')) {
        // 模拟挂死：等待 abort（AbortSignal.timeout 100ms）抛出
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
        });
      }
      return clashYaml([{ name: 'fast', type: 'vless', server: '1.1.1.1', port: 1, uuid: 'a' }]);
    };
    const r = await resolveProxyProviders(
      {
        fast: { type: 'http', url: 'http://x/fast' },
        slow: { type: 'http', url: 'http://x/slow' },
      },
      baseDeps(fetchText)
    );
    expect(r.servers.map((s) => s.name)).toEqual(['fast']);
    expect(r.succeeded).toBe(1);
    expect(r.anyFailed).toBe(true);
    expect(r.warnings.some((w) => /1\/2 成功/.test(w))).toBe(true);
  });

  it('单 provider HTTP 错误 → 其余正常 + partial', async () => {
    const fetchText = async (url: string) => {
      if (url.includes('bad')) throw new Error('HTTP Error: 503 Service Unavailable');
      return clashYaml([{ name: 'ok', type: 'vless', server: '1.1.1.1', port: 1, uuid: 'a' }]);
    };
    const r = await resolveProxyProviders(
      { ok: { type: 'http', url: 'http://x/ok' }, bad: { type: 'http', url: 'http://x/bad' } },
      baseDeps(fetchText)
    );
    expect(r.servers.map((s) => s.name)).toEqual(['ok']);
    expect(r.anyFailed).toBe(true);
    // M1：成功 provider 节点带归属；transient 失败的 provider 名进 failedProviders（供调用方精确 merge-only）。
    expect(r.servers[0].providerName).toBe('ok');
    expect(r.failedProviders).toEqual(['bad']);
  });

  it('全 provider 失败 → 0 servers + anyFailed', async () => {
    const fetchText = async () => {
      throw new Error('boom');
    };
    const r = await resolveProxyProviders(
      { a: { type: 'http', url: 'http://x/a' }, b: { type: 'http', url: 'http://x/b' } },
      baseDeps(fetchText)
    );
    expect(r.servers).toHaveLength(0);
    expect(r.succeeded).toBe(0);
    expect(r.anyFailed).toBe(true);
  });

  it('filter + override 在 provider 上生效', async () => {
    const fetchText = async () =>
      clashYaml([
        { name: 'HK-1', type: 'hysteria2', server: '1.1.1.1', port: 1, password: 'p' },
        { name: 'US-1', type: 'hysteria2', server: '2.2.2.2', port: 2, password: 'p' },
      ]);
    const r = await resolveProxyProviders(
      {
        p: {
          type: 'http',
          url: 'http://x/p',
          filter: 'HK',
          override: { 'skip-cert-verify': true, up: 100 },
        },
      },
      baseDeps(fetchText)
    );
    expect(r.servers.map((s) => s.name)).toEqual(['HK-1']);
    expect(r.servers[0].tlsSettings?.allowInsecure).toBe(true);
    expect(r.servers[0].hysteria2Settings?.upMbps).toBe(100);
  });

  it('maxProviders 截断 + 告警', async () => {
    const fetchText = async (url: string) =>
      clashYaml([
        { name: url.slice(-2), type: 'vless', server: '1.1.1.1', port: 1, uuid: url.slice(-2) },
      ]);
    const providers: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) providers[`p${i}`] = { type: 'http', url: `http://x/p${i}` };
    const deps = baseDeps(fetchText);
    deps.maxProviders = 8;
    const r = await resolveProxyProviders(providers, deps);
    expect(r.attempted).toBe(8);
    expect(r.warnings.some((w) => /超上限 8/.test(w))).toBe(true);
  });
});

describe('跨 provider 同节点指纹去重（留内联）— 在 Service 侧去重，这里验证四元组可作为去重键', () => {
  it('内联与 provider 同节点四元组相同（去重收口 Service.dedupeByFingerprint）', () => {
    const inline = parseClashProxies(
      [{ name: 'inline-name', type: 'vless', server: '1.1.1.1', port: 443, uuid: 'SAME' }],
      SUB_ID,
      NOW
    ).servers[0];
    const fromProvider = parseClashProxies(
      [{ name: 'provider-name', type: 'vless', server: '1.1.1.1', port: 443, uuid: 'SAME' }],
      SUB_ID,
      NOW
    ).servers[0];
    // 显示名不同但四元组相同 → 同指纹 → Service 去重时留首见（内联在前）。
    expect(fourTuple(inline)).toEqual(fourTuple(fromProvider));
  });
});

describe('MED-2 normalizeDuration（tuic heartbeat 格式）', () => {
  it('纯数字（毫秒整数）补 ms', () => {
    expect(normalizeDuration(10000)).toBe('10000ms');
    expect(normalizeDuration('10000')).toBe('10000ms');
    expect(normalizeDuration('1.5')).toBe('1.5ms');
  });
  it('已带单位字符串透传', () => {
    expect(normalizeDuration('10s')).toBe('10s');
    expect(normalizeDuration('500ms')).toBe('500ms');
    expect(normalizeDuration('1m')).toBe('1m');
  });
  it('空/缺省返回 undefined', () => {
    expect(normalizeDuration(undefined)).toBeUndefined();
    expect(normalizeDuration(null)).toBeUndefined();
    expect(normalizeDuration('')).toBeUndefined();
    expect(normalizeDuration('  ')).toBeUndefined();
  });
  it('tuic 节点 heartbeat-interval:10000 → 10000ms（端到端）', () => {
    const { servers } = parseClashProxies(
      [
        {
          name: 'tuic-hb',
          type: 'tuic',
          server: '8.8.8.8',
          port: 443,
          uuid: 'u',
          password: 'p',
          'heartbeat-interval': 10000,
        },
      ],
      SUB_ID,
      NOW
    );
    expect(servers[0].tuicSettings?.heartbeat).toBe('10000ms');
  });
});

describe('MED-3 shadow-tls 缺字段整节点 skip', () => {
  it('缺 host → 整节点跳过 + 计数（不入库假节点）', () => {
    const r = parseClashProxies(
      [
        {
          name: 'stls-nohost',
          type: 'ss',
          server: '1.1.1.1',
          port: 443,
          cipher: 'aes-256-gcm',
          password: 'p',
          plugin: 'shadow-tls',
          'plugin-opts': { password: 'stlspw' }, // 缺 host
        },
      ],
      SUB_ID,
      NOW
    );
    expect(r.servers).toHaveLength(0);
    expect(r.skipped).toBe(1);
    expect(r.warnings.some((w) => /shadow-tls/.test(w))).toBe(true);
  });
  it('缺 password → 整节点跳过', () => {
    const r = parseClashProxies(
      [
        {
          name: 'stls-nopw',
          type: 'ss',
          server: '1.1.1.1',
          port: 443,
          cipher: 'aes-256-gcm',
          password: 'p',
          plugin: 'shadow-tls',
          'plugin-opts': { host: 'stls.cdn.com' }, // 缺 password
        },
      ],
      SUB_ID,
      NOW
    );
    expect(r.servers).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });
  it('齐全 → 正常写 shadowTlsSettings', () => {
    const { servers } = parseClashProxies(
      [
        {
          name: 'stls-ok',
          type: 'ss',
          server: '1.1.1.1',
          port: 443,
          cipher: 'aes-256-gcm',
          password: 'p',
          plugin: 'shadow-tls',
          'plugin-opts': { password: 'stlspw', host: 'stls.cdn.com', port: 8443 },
        },
      ],
      SUB_ID,
      NOW
    );
    expect(servers).toHaveLength(1);
    expect(servers[0].shadowTlsSettings).toEqual({
      password: 'stlspw',
      sni: 'stls.cdn.com',
      fingerprint: 'chrome',
      port: 8443,
    });
  });
});

describe('M1 ReDoS 长度护栏', () => {
  it('超长 pattern（>MAX_FILTER_PATTERN_LEN）compileProviderFilter 返回 null', () => {
    const longPattern = 'a'.repeat(MAX_FILTER_PATTERN_LEN + 1);
    expect(compileProviderFilter(longPattern)).toBeNull();
    // 合法且不超长的 pattern 仍正常编译
    expect(compileProviderFilter('HK|US')).not.toBeNull();
  });
  it('超长 pattern 经 applyProviderFilters 当非法 filter 处理（不过滤 + warn）', () => {
    const warns: string[] = [];
    const longPattern = 'x'.repeat(MAX_FILTER_PATTERN_LEN + 50);
    const res = applyProviderFilters(
      [{ name: 'a' }, { name: 'b' }],
      longPattern,
      undefined,
      (m) => warns.push(m),
      'prov'
    ) as Array<{ name: string }>;
    expect(res).toHaveLength(2);
    expect(warns.some((w) => /超长|非法/.test(w))).toBe(true);
  });
  it('超长 name 截断后仍可被短 filter 命中（不冻结、可匹配前缀）', () => {
    const longName = 'HK' + 'z'.repeat(MAX_FILTER_NAME_LEN + 100);
    const res = applyProviderFilters(
      [{ name: longName }, { name: 'US' }],
      'HK',
      undefined,
      () => {},
      'p'
    ) as Array<{ name: string }>;
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe(longName);
  });
});

describe('LOW-2 vmess network:http 读 http-opts（path 数组取首 + host）', () => {
  it('http-opts path 数组取首、headers.Host 落 httpSettings', () => {
    const { servers } = parseClashProxies(
      [
        {
          name: 'vmess-http',
          type: 'vmess',
          server: '2.2.2.2',
          port: 80,
          uuid: 'vm',
          network: 'http',
          'http-opts': { path: ['/first', '/second'], headers: { Host: 'h.cdn.com' } },
        },
      ],
      SUB_ID,
      NOW
    );
    const s = servers[0];
    expect(s.network).toBe('http');
    expect(s.httpSettings?.path).toBe('/first');
    expect(s.httpSettings?.host).toEqual(['h.cdn.com']);
  });
  it('http-opts host 为数组时透传', () => {
    const { servers } = parseClashProxies(
      [
        {
          name: 'vmess-http2',
          type: 'vmess',
          server: '2.2.2.2',
          port: 80,
          uuid: 'vm',
          network: 'http',
          'http-opts': { path: ['/p'], host: ['a.com', 'b.com'] },
        },
      ],
      SUB_ID,
      NOW
    );
    expect(servers[0].httpSettings?.host).toEqual(['a.com', 'b.com']);
  });
});

describe('LOW-3 hy2 单端口段补 :n', () => {
  it('单端口 "1000" → "1000:1000"', () => {
    const { servers } = parseClashProxies(
      [
        {
          name: 'hy2-single',
          type: 'hysteria2',
          server: '7.7.7.7',
          port: 1000,
          password: 'p',
          ports: '1000',
        },
      ],
      SUB_ID,
      NOW
    );
    expect(servers[0].hysteria2Settings?.serverPorts).toBe('1000:1000');
  });
  it('混合段 "1000,2000-3000" → "1000:1000,2000:3000"', () => {
    const { servers } = parseClashProxies(
      [
        {
          name: 'hy2-mix',
          type: 'hysteria2',
          server: '7.7.7.7',
          port: 1000,
          password: 'p',
          ports: '1000,2000-3000',
        },
      ],
      SUB_ID,
      NOW
    );
    expect(servers[0].hysteria2Settings?.serverPorts).toBe('1000:1000,2000:3000');
  });
});

describe('LOW-4 override skip-cert-verify:false 也覆盖（赋值语义）', () => {
  it('override false → allowInsecure 被赋值为 false（收紧）', () => {
    const servers: ServerConfig[] = [
      {
        id: '1',
        name: 'a',
        protocol: 'vless',
        address: 'x',
        port: 1,
        uuid: 'u',
        tlsSettings: { allowInsecure: true },
      },
    ];
    applyOverride(servers, { 'skip-cert-verify': false });
    expect(servers[0].tlsSettings?.allowInsecure).toBe(false);
  });
  it('override 未给 skip-cert-verify → 不动 allowInsecure', () => {
    const servers: ServerConfig[] = [
      {
        id: '1',
        name: 'a',
        protocol: 'vless',
        address: 'x',
        port: 1,
        uuid: 'u',
        tlsSettings: { allowInsecure: true },
      },
    ];
    applyOverride(servers, { up: 100 });
    expect(servers[0].tlsSettings?.allowInsecure).toBe(true);
  });
});

// ── issue #263：Clash 路径与分享链/sing-box JSON 统一「不支持传输拒节点」口径 + reality 完整性 ──
describe('传输层白名单 + reality 完整性（issue #263 统一口径）', () => {
  const NOW = '2026-07-07T00:00:00.000Z';

  it('vless network=xhttp → fail 计数 + 聚合告警，不入库', () => {
    const r = parseClashProxies(
      [{ name: 'x', type: 'vless', server: 'a.com', port: 443, uuid: 'u', network: 'xhttp' }],
      'sub',
      NOW
    );
    expect(r.servers).toHaveLength(0);
    expect(r.failed).toBe(1);
    expect(r.warnings.join('\n')).toMatch(/不支持的传输层类型: xhttp/);
  });

  it('network 缺省/tcp 正常入库（不受白名单影响）', () => {
    const r = parseClashProxies(
      [
        { name: 'a', type: 'vless', server: 'a.com', port: 443, uuid: 'u' },
        { name: 'b', type: 'vless', server: 'a.com', port: 444, uuid: 'u', network: 'tcp' },
      ],
      'sub',
      NOW
    );
    expect(r.servers).toHaveLength(2);
    expect(r.failed).toBe(0);
  });

  it('reality-opts 缺 public-key → fail（防按普通 TLS 入库成假节点）', () => {
    const r = parseClashProxies(
      [
        {
          name: 'r',
          type: 'vless',
          server: 'a.com',
          port: 443,
          uuid: 'u',
          tls: true,
          'reality-opts': { 'short-id': '01ab' },
        },
      ],
      'sub',
      NOW
    );
    expect(r.servers).toHaveLength(0);
    expect(r.failed).toBe(1);
    expect(r.warnings.join('\n')).toMatch(/public-key/);
  });
});

describe('mihomo HTTPUpgrade 表达（network:ws + v2ray-http-upgrade）', () => {
  const NOW = '2026-07-07T00:00:00.000Z';

  it('ws-opts.v2ray-http-upgrade:true → network=httpupgrade（settings 落点不变）', () => {
    const { servers } = parseClashProxies(
      [
        {
          name: 'hu',
          type: 'vless',
          server: 'a.com',
          port: 443,
          uuid: 'u',
          network: 'ws',
          'ws-opts': { path: '/up', headers: { Host: 'h.com' }, 'v2ray-http-upgrade': true },
        },
      ],
      'sub',
      NOW
    );
    expect(servers).toHaveLength(1);
    expect(servers[0].network).toBe('httpupgrade');
    expect(servers[0].wsSettings).toEqual({ path: '/up', headers: { Host: 'h.com' } });
  });

  it('普通 ws（无 flag）→ 仍 ws', () => {
    const { servers } = parseClashProxies(
      [
        {
          name: 'ws',
          type: 'vless',
          server: 'a.com',
          port: 443,
          uuid: 'u',
          network: 'ws',
          'ws-opts': { path: '/ws' },
        },
      ],
      'sub',
      NOW
    );
    expect(servers[0].network).toBe('ws');
  });
});
