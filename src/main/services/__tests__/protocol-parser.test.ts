/**
 * ProtocolParser parse/generate 特征 + 往返单测（重构安全网）。
 *
 * 目的：审计 §6 Tier-1 #8「抽 parse 头部/generate 尾部样板 helper」前的离线护栏——
 *   原 14 协议 parse/generate 零 URL 解析覆盖，重构无法离线验证等价。本套锁两件事：
 *   ① 特征（characterization）：真实 share URL → 断言关键字段，钉住 parse 行为；
 *   ② 往返不动点（fixpoint）：parse → generate → parse 回到首解析归一化形态（id 易变除外），
 *      锁 parse↔generate 对称性。重构后两网全绿即等价。
 *
 * ProtocolParser 纯逻辑（crypto + 类型 + type-only LogManager），无 electron/runtime 依赖，可直测。
 * 往返 URL 刻意避开「generate 不回写」的字段（如 naive/https 无 query、vmess 不写 insecure），
 *   使首解析结果即不动点；这些「单向丢弃」由特征断言单独覆盖。
 */
import { ProtocolParser } from '../ProtocolParser';
import type { ServerConfig } from '../../../shared/types';

const parser = new ProtocolParser();

function stripId(c: ServerConfig) {
  const { id: _id, ...rest } = c;
  return rest;
}

/** parse → generate → parse 应回到首解析归一化形态（id 易变除外）。 */
function expectRoundTripStable(url: string): ServerConfig {
  const first = parser.parseUrl(url);
  const second = parser.parseUrl(parser.generateUrl(first));
  expect(stripId(second)).toEqual(stripId(first));
  return first;
}

describe('isSupported', () => {
  it.each([
    'vless://x',
    'trojan://x',
    'hysteria2://x',
    'hy2://x',
    'ss://x',
    'anytls://x',
    'snell://x',
    'tuic://x',
    'naive://x',
    'http2://x',
    'naive+https://x',
    'vmess://x',
    'socks5://x',
    'socks://x',
    's5://x',
    'http://x',
    'https://x',
  ])('支持 %s', (u) => expect(parser.isSupported(u)).toBe(true));

  it.each(['ftp://x', 'wireguard://x', 'tailscale://x', 'foobar'])('不支持 %s', (u) =>
    expect(parser.isSupported(u)).toBe(false)
  );
});

describe('VLESS', () => {
  it('ws+tls 特征', () => {
    const c = parser.parseUrl(
      'vless://11111111-1111-1111-1111-111111111111@a.example.com:443?encryption=none&type=ws&path=%2Fws&host=cdn.example.com&security=tls&sni=cdn.example.com&alpn=h2&fp=chrome#vless-ws'
    );
    expect(c.protocol).toBe('vless');
    expect(c.address).toBe('a.example.com');
    expect(c.port).toBe(443);
    expect(c.uuid).toBe('11111111-1111-1111-1111-111111111111');
    expect(c.encryption).toBe('none');
    expect(c.network).toBe('ws');
    expect(c.wsSettings).toEqual({ path: '/ws', headers: { Host: 'cdn.example.com' } });
    expect(c.security).toBe('tls');
    expect(c.tlsSettings).toMatchObject({
      serverName: 'cdn.example.com',
      alpn: ['h2'],
      fingerprint: 'chrome',
    });
    expect(c.name).toBe('vless-ws');
  });

  it('reality 特征', () => {
    const c = parser.parseUrl(
      'vless://22222222-2222-2222-2222-222222222222@b.example.com:443?encryption=none&flow=xtls-rprx-vision&type=tcp&security=reality&sni=apple.com&fp=chrome&pbk=PUBKEYxyz&sid=abcd#vless-reality'
    );
    expect(c.flow).toBe('xtls-rprx-vision');
    expect(c.security).toBe('reality');
    expect(c.realitySettings).toEqual({ publicKey: 'PUBKEYxyz', shortId: 'abcd' });
    expect(c.tlsSettings).toMatchObject({ serverName: 'apple.com', fingerprint: 'chrome' });
  });

  it('缺省名 = address:port', () => {
    const c = parser.parseUrl('vless://uuid-x@h.example.com:443');
    expect(c.name).toBe('h.example.com:443');
  });

  it('缺 UUID → 抛错', () => {
    expect(() => parser.parseUrl('vless://@h.example.com:443')).toThrow(/缺少 UUID/);
  });

  it('往返不动点 ws+tls', () =>
    void expectRoundTripStable(
      'vless://11111111-1111-1111-1111-111111111111@a.example.com:443?encryption=none&type=ws&path=%2Fws&host=cdn.example.com&security=tls&sni=cdn.example.com&alpn=h2&fp=chrome#vless-ws'
    ));

  it('往返不动点 reality', () =>
    void expectRoundTripStable(
      'vless://22222222-2222-2222-2222-222222222222@b.example.com:443?encryption=none&flow=xtls-rprx-vision&type=tcp&security=reality&sni=apple.com&fp=chrome&pbk=PUBKEYxyz&sid=abcd#vless-reality'
    ));
});

describe('Trojan', () => {
  it('特征', () => {
    const c = parser.parseUrl(
      'trojan://trojanpass@c.example.com:443?security=tls&sni=t.example.com&alpn=h2&fp=chrome&type=ws&path=%2Ftj&host=t.example.com#trojan-1'
    );
    expect(c.protocol).toBe('trojan');
    expect(c.password).toBe('trojanpass');
    expect(c.security).toBe('tls');
    expect(c.network).toBe('ws');
    expect(c.wsSettings).toEqual({ path: '/tj', headers: { Host: 't.example.com' } });
    expect(c.tlsSettings).toMatchObject({ serverName: 't.example.com' });
  });

  it('security 缺省为 tls', () => {
    const c = parser.parseUrl('trojan://pw@c.example.com:443#n');
    expect(c.security).toBe('tls');
  });

  it('往返不动点', () =>
    void expectRoundTripStable(
      'trojan://trojanpass@c.example.com:443?security=tls&sni=t.example.com&alpn=h2&fp=chrome&type=ws&path=%2Ftj&host=t.example.com#trojan-1'
    ));
});

describe('Hysteria2', () => {
  it('特征（含 obfs/带宽）', () => {
    const c = parser.parseUrl(
      'hysteria2://hy2pass@d.example.com:8443?up_mbps=100&down_mbps=500&obfs=salamander&obfs-password=obfspw&sni=h.example.com&insecure=1&alpn=h3#hy2-1'
    );
    expect(c.protocol).toBe('hysteria2');
    expect(c.password).toBe('hy2pass');
    expect(c.port).toBe(8443);
    expect(c.security).toBe('tls');
    expect(c.hysteria2Settings).toMatchObject({
      upMbps: 100,
      downMbps: 500,
      obfs: { type: 'salamander', password: 'obfspw' },
    });
    expect(c.tlsSettings).toMatchObject({
      serverName: 'h.example.com',
      allowInsecure: true,
      alpn: ['h3'],
    });
  });

  it('hy2 别名 = hysteria2 + 缺 sni 回落 address', () => {
    const c = parser.parseUrl('hy2://pw@d.example.com:443#n');
    expect(c.protocol).toBe('hysteria2');
    expect(c.tlsSettings?.serverName).toBe('d.example.com');
  });

  it('缺密码 → 抛错', () => {
    expect(() => parser.parseUrl('hysteria2://@d.example.com:443')).toThrow(/缺少密码/);
  });

  it('往返不动点', () =>
    void expectRoundTripStable(
      'hysteria2://hy2pass@d.example.com:8443?up_mbps=100&down_mbps=500&obfs=salamander&obfs-password=obfspw&sni=h.example.com&insecure=1&alpn=h3#hy2-1'
    ));
});

describe('Shadowsocks', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  it('Base64 userinfo 特征', () => {
    const c = parser.parseUrl(`ss://${b64('aes-256-gcm:sspass')}@e.example.com:8388#ss-b64`);
    expect(c.protocol).toBe('shadowsocks');
    expect(c.address).toBe('e.example.com');
    expect(c.port).toBe(8388);
    expect(c.shadowsocksSettings).toEqual({ method: 'aes-256-gcm', password: 'sspass' });
  });

  it('SIP002 明文 method:password 特征', () => {
    const c = parser.parseUrl('ss://aes-256-gcm:sspass@e.example.com:8388#ss-sip002');
    expect(c.shadowsocksSettings).toMatchObject({ method: 'aes-256-gcm', password: 'sspass' });
  });

  it('plugin 参数', () => {
    const c = parser.parseUrl(
      `ss://${b64('aes-128-gcm:pw')}@e.example.com:8388?plugin=obfs-local%3Bobfs%3Dhttp#ss-plugin`
    );
    expect(c.shadowsocksSettings?.plugin).toBe('obfs-local');
    expect(c.shadowsocksSettings?.pluginOptions).toBe('obfs=http');
  });

  it('裸 IPv6 地址预处理（加方括号 + 端口分离）', () => {
    const c = parser.parseUrl(`ss://${b64('aes-256-gcm:pw')}@2001:db8::1:8388#ss-v6`);
    expect(c.address).toBe('2001:db8::1');
    expect(c.port).toBe(8388);
  });

  it('缺 userinfo → 抛错', () => {
    expect(() => parser.parseUrl('ss://@e.example.com:8388')).toThrow(/缺少加密信息/);
  });

  it('往返不动点（base64）', () =>
    void expectRoundTripStable(`ss://${b64('aes-256-gcm:sspass')}@e.example.com:8388#ss-b64`));
});

describe('AnyTLS', () => {
  it('特征（会话参数）', () => {
    const c = parser.parseUrl(
      'anytls://atlspass@f.example.com:443?security=tls&sni=at.example.com&fp=chrome&idle_session_timeout=30s&idle_session_check_interval=5s&min_idle_session=2#anytls-1'
    );
    expect(c.protocol).toBe('anytls');
    expect(c.password).toBe('atlspass');
    expect(c.security).toBe('tls');
    expect(c.tlsSettings).toMatchObject({ serverName: 'at.example.com' });
    expect(c.anyTlsSettings).toEqual({
      idleSessionTimeout: '30s',
      idleSessionCheckInterval: '5s',
      minIdleSession: 2,
    });
  });

  it('security 缺省为 tls', () => {
    const c = parser.parseUrl('anytls://pw@f.example.com:443#n');
    expect(c.security).toBe('tls');
  });

  // 收敛面对齐：URL 导入路径的 idle duration 与 Clash 路径同款经 normalizeDuration
  // 规整裸毫秒（防外部手写 anytls:// 带无单位 idle → sing-box "missing unit"）。
  it('idle duration 裸毫秒补 ms（与 Clash 路径一致）', () => {
    const c = parser.parseUrl(
      'anytls://pw@f.example.com:443?security=tls&idle_session_check_interval=30000&idle_session_timeout=5000&min_idle_session=3#n'
    );
    expect(c.anyTlsSettings).toEqual({
      idleSessionCheckInterval: '30000ms',
      idleSessionTimeout: '5000ms',
      minIdleSession: 3,
    });
  });

  // #86-122 NIT②：min_idle_session 口径对齐 Clash num()/生成侧 !==undefined。
  it('min_idle_session=0 保留（合法值，非 truthy 丢弃）', () => {
    const c = parser.parseUrl('anytls://pw@f.example.com:443?security=tls&min_idle_session=0#n');
    expect(c.anyTlsSettings?.minIdleSession).toBe(0);
  });

  it('min_idle_session 非数字 → 丢弃（不写 NaN，对齐 Clash num() 防 NaN 漂移）', () => {
    const c = parser.parseUrl('anytls://pw@f.example.com:443?security=tls&min_idle_session=abc#n');
    expect(c.anyTlsSettings?.minIdleSession).toBeUndefined();
  });

  it('往返不动点', () =>
    void expectRoundTripStable(
      'anytls://atlspass@f.example.com:443?security=tls&sni=at.example.com&fp=chrome&idle_session_timeout=30s&idle_session_check_interval=5s&min_idle_session=2#anytls-1'
    ));
});

describe('TUIC', () => {
  it('特征（uuid:password 凭据）', () => {
    const c = parser.parseUrl(
      'tuic://uuid-tuic:tuicpass@g.example.com:443?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni=tu.example.com&allow_insecure=1#tuic-1'
    );
    expect(c.protocol).toBe('tuic');
    expect(c.uuid).toBe('uuid-tuic');
    expect(c.password).toBe('tuicpass');
    expect(c.security).toBe('tls');
    expect(c.network).toBe('tcp');
    expect(c.tuicSettings).toEqual({ congestionControl: 'bbr', udpRelayMode: 'native' });
    expect(c.tlsSettings).toMatchObject({
      serverName: 'tu.example.com',
      allowInsecure: true,
      alpn: ['h3'],
    });
  });

  it('缺 password → 抛错', () => {
    expect(() => parser.parseUrl('tuic://onlyuuid@g.example.com:443')).toThrow(
      /缺少 uuid 或 password/
    );
  });

  it('往返不动点', () =>
    void expectRoundTripStable(
      'tuic://uuid-tuic:tuicpass@g.example.com:443?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni=tu.example.com&allow_insecure=1#tuic-1'
    ));

  // zero_rtt_handshake parse↔generate 往返守恒：加字段漏扫 generate 端会在此断言失守。
  it('zero_rtt_handshake=1 解析为 true', () => {
    const c = parser.parseUrl(
      'tuic://uuid-tuic:tuicpass@g.example.com:443?congestion_control=bbr&zero_rtt_handshake=1&sni=tu.example.com#zrtt'
    );
    expect(c.tuicSettings?.zeroRttHandshake).toBe(true);
    // generate 端必须回写，否则往返丢字段
    expect(parser.generateUrl(c)).toContain('zero_rtt_handshake=1');
  });

  it('往返不动点（zeroRttHandshake=true）', () =>
    void expectRoundTripStable(
      'tuic://uuid-tuic:tuicpass@g.example.com:443?congestion_control=bbr&udp_relay_mode=native&zero_rtt_handshake=1&alpn=h3&sni=tu.example.com#zrtt-on'
    ));

  it('往返不动点（zeroRttHandshake 缺省，不被臆造）', () => {
    const url =
      'tuic://uuid-tuic:tuicpass@g.example.com:443?congestion_control=bbr&sni=tu.example.com#zrtt-off';
    const c = parser.parseUrl(url);
    expect(c.tuicSettings?.zeroRttHandshake).toBeUndefined();
    expect(parser.generateUrl(c)).not.toContain('zero_rtt_handshake');
    void expectRoundTripStable(url);
  });

  // #86-122 NIT①：zero_rtt_handshake=0 显式 false 往返守恒（旧 truthy 检查丢 false → 再解析得 undefined）。
  it('zero_rtt_handshake=0 解析为显式 false，generate 回写 =0（往返守恒，不退化为 undefined）', () => {
    const c = parser.parseUrl(
      'tuic://uuid-tuic:tuicpass@g.example.com:443?congestion_control=bbr&zero_rtt_handshake=0&sni=tu.example.com#zrtt0'
    );
    expect(c.tuicSettings?.zeroRttHandshake).toBe(false);
    expect(parser.generateUrl(c)).toContain('zero_rtt_handshake=0');
    // 再解析仍为 false（守恒，非被丢成 undefined）
    const c2 = parser.parseUrl(parser.generateUrl(c));
    expect(c2.tuicSettings?.zeroRttHandshake).toBe(false);
  });
});

describe('Naive', () => {
  it('特征（naive+https）', () => {
    const c = parser.parseUrl('naive+https://naiveuser:naivepass@h.example.com:443#naive-1');
    expect(c.protocol).toBe('naive');
    expect(c.username).toBe('naiveuser');
    expect(c.password).toBe('naivepass');
    expect(c.security).toBe('tls');
    expect(c.tlsSettings?.serverName).toBe('h.example.com');
  });

  it.each([
    'http2://u:p@h.example.com:443#n',
    'naive://u:p@h.example.com:443#n',
    'naive+https://u:p@h.example.com:443#n',
    'https://u:p@h.example.com:443#naive',
  ])('别名归一为 naive: %s', (u) => expect(parser.parseUrl(u).protocol).toBe('naive'));

  it('缺用户名/密码 → 抛错', () => {
    expect(() => parser.parseUrl('naive+https://h.example.com:443')).toThrow(/缺少用户名或密码/);
  });

  it('往返不动点', () =>
    void expectRoundTripStable('naive+https://naiveuser:naivepass@h.example.com:443#naive-1'));
});

describe('VMess', () => {
  const mkVmess = (data: Record<string, unknown>) =>
    'vmess://' + Buffer.from(JSON.stringify(data)).toString('base64');

  it('特征（ws+tls）', () => {
    const c = parser.parseUrl(
      mkVmess({
        v: '2',
        ps: 'My VMess',
        add: 'i.example.com',
        port: '443',
        id: 'vmess-uuid',
        aid: '0',
        scy: 'auto',
        net: 'ws',
        host: 'cdn.com',
        path: '/ws',
        tls: 'tls',
        sni: 'cdn.com',
        fp: 'chrome',
        alpn: 'h2',
      })
    );
    expect(c.protocol).toBe('vmess');
    expect(c.address).toBe('i.example.com');
    expect(c.port).toBe(443);
    expect(c.uuid).toBe('vmess-uuid');
    expect(c.alterId).toBe(0);
    expect(c.vmessSecurity).toBe('auto');
    expect(c.network).toBe('ws');
    expect(c.wsSettings).toEqual({ path: '/ws', headers: { Host: 'cdn.com' } });
    expect(c.security).toBe('tls');
    expect(c.tlsSettings).toMatchObject({
      serverName: 'cdn.com',
      fingerprint: 'chrome',
      alpn: ['h2'],
    });
    expect(c.name).toBe('My VMess');
  });

  it('配置不完整 → 抛错', () => {
    expect(() => parser.parseUrl(mkVmess({ add: 'x', port: '443' }))).toThrow(/解析失败/);
  });

  it('往返不动点', () =>
    void expectRoundTripStable(
      mkVmess({
        v: '2',
        ps: 'My VMess',
        add: 'i.example.com',
        port: '443',
        id: 'vmess-uuid',
        aid: '0',
        scy: 'auto',
        net: 'ws',
        host: 'cdn.com',
        path: '/ws',
        tls: 'tls',
        sni: 'cdn.com',
        fp: 'chrome',
        alpn: 'h2',
      })
    ));
});

describe('SOCKS', () => {
  it('特征', () => {
    const c = parser.parseUrl('socks5://sockuser:sockpass@j.example.com:1080#socks-1');
    expect(c.protocol).toBe('socks');
    expect(c.username).toBe('sockuser');
    expect(c.password).toBe('sockpass');
    expect(c.network).toBe('tcp');
    expect(c.security).toBe('none');
  });

  it.each([
    'socks5://u:p@j.example.com:1080#n',
    'socks://u:p@j.example.com:1080#n',
    's5://u:p@j.example.com:1080#n',
  ])('别名归一为 socks: %s', (u) => expect(parser.parseUrl(u).protocol).toBe('socks'));

  it('缺省端口 1080', () => {
    const c = parser.parseUrl('socks5://u:p@j.example.com#n');
    expect(c.port).toBe(1080);
  });

  it('往返不动点', () =>
    void expectRoundTripStable('socks5://sockuser:sockpass@j.example.com:1080#socks-1'));
});

describe('HTTP/HTTPS', () => {
  it('http 特征（明文）', () => {
    const c = parser.parseUrl('http://httpuser:httppass@k.example.com:8080#http-1');
    expect(c.protocol).toBe('http');
    expect(c.username).toBe('httpuser');
    expect(c.password).toBe('httppass');
    expect(c.port).toBe(8080);
    expect(c.security).toBe('none');
  });

  it('https 特征（tls + 默认 sni）', () => {
    const c = parser.parseUrl('https://huser:hpass@l.example.com:443#https-1');
    expect(c.security).toBe('tls');
    expect(c.tlsSettings?.serverName).toBe('l.example.com');
  });

  it('往返不动点（http 明文）', () =>
    void expectRoundTripStable('http://httpuser:httppass@k.example.com:8080#http-1'));

  it('往返不动点（https）', () =>
    void expectRoundTripStable('https://huser:hpass@l.example.com:443#https-1'));
});

describe('IPv6 / 通用', () => {
  it('VLESS 方括号 IPv6 去括号', () => {
    const c = parser.parseUrl('vless://uuid-v6@[2001:db8::1]:443?security=tls&sni=x#v6');
    expect(c.address).toBe('2001:db8::1');
    expect(c.port).toBe(443);
  });

  it('不支持协议 → 抛错', () => {
    expect(() => parser.parseUrl('ftp://x.example.com')).toThrow(/不支持的协议/);
  });

  it('generateUrl 不支持协议 → 抛错', () => {
    expect(() => parser.generateUrl({ id: 'x', protocol: 'wireguard' } as ServerConfig)).toThrow(
      /不支持的协议/
    );
  });
});

// 直接钉死 generateUrl 输出字符串：往返不动点对 parse↔generate 的「对称错误」（两侧一起改错仍闭合）是盲区，
// 此处独立断言 generate 输出，使 buildShareUrl/encodeShareName/append*Params 从「仅往返覆盖」升为「独立可验」。
describe('generate 输出精确断言', () => {
  const g = (c: Partial<ServerConfig>) => parser.generateUrl(c as ServerConfig);
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  it('vless tls 最简', () => {
    expect(
      g({
        protocol: 'vless',
        address: 'a.com',
        port: 443,
        uuid: 'U1',
        name: 'N1',
        encryption: 'none',
        security: 'tls',
        tlsSettings: { serverName: 's.com' },
      })
    ).toBe('vless://U1@a.com:443?encryption=none&security=tls&sni=s.com#N1');
  });

  it('vless reality（pbk/sid）', () => {
    expect(
      g({
        protocol: 'vless',
        address: 'a.com',
        port: 443,
        uuid: 'U',
        name: 'R',
        encryption: 'none',
        security: 'reality',
        tlsSettings: { serverName: 'apple.com', fingerprint: 'chrome' },
        realitySettings: { publicKey: 'PBK', shortId: 'sid1' },
      })
    ).toBe(
      'vless://U@a.com:443?encryption=none&security=reality&sni=apple.com&fp=chrome&pbk=PBK&sid=sid1#R'
    );
  });

  it('vless grpc（serviceName/multiMode）', () => {
    expect(
      g({
        protocol: 'vless',
        address: 'a.com',
        port: 443,
        uuid: 'U',
        name: 'G',
        network: 'grpc',
        grpcSettings: { serviceName: 'svc', multiMode: true },
      })
    ).toBe('vless://U@a.com:443?type=grpc&serviceName=svc&mode=multi#G');
  });

  it('vless ws（maxEarlyData/earlyDataHeaderName）', () => {
    expect(
      g({
        protocol: 'vless',
        address: 'a.com',
        port: 443,
        uuid: 'U',
        name: 'W',
        network: 'ws',
        wsSettings: {
          path: '/p',
          headers: { Host: 'hh' },
          maxEarlyData: 2048,
          earlyDataHeaderName: 'X-ED',
        },
      })
    ).toBe(
      'vless://U@a.com:443?type=ws&path=%2Fp&host=hh&maxEarlyData=2048&earlyDataHeaderName=X-ED#W'
    );
  });

  it('vless http network（host[]/method）', () => {
    expect(
      g({
        protocol: 'vless',
        address: 'a.com',
        port: 443,
        uuid: 'U',
        name: 'H',
        network: 'http',
        httpSettings: { host: ['x.com', 'y.com'], path: '/hp', method: 'GET' },
      })
    ).toBe('vless://U@a.com:443?type=http&host=x.com%2Cy.com&path=%2Fhp&method=GET#H');
  });

  it('trojan 最简', () => {
    expect(
      g({
        protocol: 'trojan',
        address: 'b.com',
        port: 443,
        password: 'P2',
        name: 'N2',
        security: 'tls',
        tlsSettings: { serverName: 't.com' },
      })
    ).toBe('trojan://P2@b.com:443?security=tls&sni=t.com#N2');
  });

  it('hysteria2（obfs/带宽/insecure）', () => {
    expect(
      g({
        protocol: 'hysteria2',
        address: 'c.com',
        port: 443,
        password: 'P3',
        name: 'N3',
        security: 'tls',
        hysteria2Settings: {
          upMbps: 100,
          downMbps: 500,
          obfs: { type: 'salamander', password: 'op' },
          network: 'udp',
        },
        tlsSettings: { serverName: 'h.com', allowInsecure: true, alpn: ['h3'] },
      })
    ).toBe(
      'hysteria2://P3@c.com:443?up_mbps=100&down_mbps=500&obfs=salamander&obfs-password=op&network=udp&sni=h.com&insecure=1&alpn=h3#N3'
    );
  });

  it('anytls（会话参数）', () => {
    expect(
      g({
        protocol: 'anytls',
        address: 'd.com',
        port: 443,
        password: 'P4',
        name: 'N4',
        security: 'tls',
        tlsSettings: { serverName: 'a.com' },
        anyTlsSettings: {
          idleSessionCheckInterval: '5s',
          idleSessionTimeout: '30s',
          minIdleSession: 2,
        },
      })
    ).toBe(
      'anytls://P4@d.com:443?security=tls&sni=a.com&idle_session_check_interval=5s&idle_session_timeout=30s&min_idle_session=2#N4'
    );
  });

  it('naive（http2，无 query）', () => {
    expect(
      g({
        protocol: 'naive',
        address: 'e.com',
        port: 443,
        username: 'U5',
        password: 'P5',
        name: 'N5',
      })
    ).toBe('http2://U5:P5@e.com:443#N5');
  });

  it('shadowsocks（base64 userinfo）', () => {
    expect(
      g({
        protocol: 'shadowsocks',
        address: 'f.com',
        port: 8388,
        name: 'N6',
        shadowsocksSettings: { method: 'aes-256-gcm', password: 'P6' },
      })
    ).toBe(`ss://${b64('aes-256-gcm:P6')}@f.com:8388#N6`);
  });

  it('socks 有凭据', () => {
    expect(
      g({
        protocol: 'socks',
        address: 'g.com',
        port: 1080,
        username: 'U7',
        password: 'P7',
        name: 'N7',
      })
    ).toBe('socks5://U7:P7@g.com:1080#N7');
  });

  it('socks 无凭据（无 @ 前缀）', () => {
    expect(g({ protocol: 'socks', address: 'g.com', port: 1080, name: 'N8' })).toBe(
      'socks5://g.com:1080#N8'
    );
  });

  it('http 明文有凭据', () => {
    expect(
      g({
        protocol: 'http',
        address: 'h.com',
        port: 8080,
        username: 'U9',
        password: 'P9',
        name: 'N9',
        security: 'none',
      })
    ).toBe('http://U9:P9@h.com:8080#N9');
  });

  it('https 无凭据', () => {
    expect(g({ protocol: 'http', address: 'i.com', port: 443, name: 'N10', security: 'tls' })).toBe(
      'https://i.com:443#N10'
    );
  });

  it('名称含空格 → encodeURIComponent', () => {
    expect(g({ protocol: 'socks', address: 'g.com', port: 1080, name: 'My Node' })).toBe(
      'socks5://g.com:1080#My%20Node'
    );
  });

  it('缺名 → 回落 encodeURIComponent(address:port)', () => {
    expect(
      g({ protocol: 'vless', address: 'a.com', port: 443, uuid: 'U', encryption: 'none' })
    ).toBe('vless://U@a.com:443?encryption=none#a.com%3A443');
  });
});

describe('VMess insecure 单向丢弃（parse 侧特征：generate 不回写，故仅 parse 断言）', () => {
  it('insecure=1 → allowInsecure=true', () => {
    const url =
      'vmess://' +
      Buffer.from(
        JSON.stringify({
          v: '2',
          ps: 'V',
          add: 'x.com',
          port: '443',
          id: 'uid',
          net: 'tcp',
          tls: 'tls',
          insecure: 1,
          sni: 's.com',
        })
      ).toString('base64');
    expect(parser.parseUrl(url).tlsSettings?.allowInsecure).toBe(true);
  });
});

// ── issue #263：传输层归一化/白名单 + 裸 IPv6 泛化 + reality 完整性 + hy2 obfs 剥离告警 ──
describe('传输层归一化与白名单（issue #263）', () => {
  it('vless type=httpupgrade → network=httpupgrade + wsSettings 承载 path/host', () => {
    const c = parser.parseUrl(
      'vless://uuid-1@a.com:443?encryption=none&type=httpupgrade&path=%2Fup&host=cdn.example.com&security=tls&sni=a.com#n'
    );
    expect(c.network).toBe('httpupgrade');
    expect(c.wsSettings?.path).toBe('/up');
    expect(c.wsSettings?.headers?.Host).toBe('cdn.example.com');
  });

  it('往返不动点 httpupgrade（generate 回写 path/host）', () => {
    expectRoundTripStable(
      'vless://uuid-1@a.com:443?encryption=none&type=httpupgrade&path=%2Fup&host=cdn.example.com&security=tls&sni=a.com&fp=chrome#n'
    );
  });

  it('vless type=h2 → network=http（builder 兼容口径）', () => {
    const c = parser.parseUrl(
      'vless://uuid-1@a.com:443?encryption=none&type=h2&path=%2Fh2&host=h.example.com#n'
    );
    expect(c.network).toBe('http');
    expect(c.httpSettings?.path).toBe('/h2');
  });

  it('type 大小写不敏感 + raw/none 归一 tcp（Xray 1.8.24+ 别名）', () => {
    expect(parser.parseUrl('vless://u@a.com:443?type=RAW#n').network).toBe('tcp');
    expect(parser.parseUrl('vless://u@a.com:443?type=none#n').network).toBe('tcp');
    expect(parser.parseUrl('vless://u@a.com:443?type=WS&path=%2Fp#n').network).toBe('ws');
  });

  it('vless/trojan type=xhttp|splithttp|kcp（sing-box 不支持）→ 整节点拒绝且消息可检索', () => {
    expect(() => parser.parseUrl('vless://u@a.com:443?type=xhttp#n')).toThrow(
      /不支持的传输层类型: xhttp/
    );
    expect(() => parser.parseUrl('trojan://pw@a.com:443?type=splithttp#n')).toThrow(
      /不支持的传输层类型: splithttp/
    );
    expect(() => parser.parseUrl('vless://u@a.com:443?type=kcp#n')).toThrow(
      /不支持的传输层类型: kcp/
    );
  });

  it('vmess net 未知（kcp/quic）→ 拒绝；net=raw → tcp（与 vless/trojan 统一口径）', () => {
    const vmessUrl = (net: string) =>
      'vmess://' +
      Buffer.from(
        JSON.stringify({ v: '2', ps: 'V', add: 'x.com', port: '443', id: 'uid', net })
      ).toString('base64');
    expect(() => parser.parseUrl(vmessUrl('kcp'))).toThrow(/不支持的传输层类型: kcp/);
    expect(() => parser.parseUrl(vmessUrl('quic'))).toThrow(/不支持的传输层类型: quic/);
    expect(parser.parseUrl(vmessUrl('raw')).network).toBe('tcp');
  });

  it('裸 IPv6（无方括号）泛化到 vless/trojan（原仅 ss://）', () => {
    const v = parser.parseUrl('vless://uuid-1@2001:db8::1:443?encryption=none#v6');
    expect(v.address).toBe('2001:db8::1');
    expect(v.port).toBe(443);
    const t = parser.parseUrl('trojan://pw@2001:db8::2:8443#t6');
    expect(t.address).toBe('2001:db8::2');
    expect(t.port).toBe(8443);
  });

  it('reality 缺 pbk → 整节点拒绝（vless/trojan；防裸 TCP 假节点入库）', () => {
    expect(() => parser.parseUrl('vless://u@a.com:443?security=reality&sid=ab#n')).toThrow(/pbk/);
    expect(() => parser.parseUrl('trojan://pw@a.com:443?security=reality#n')).toThrow(/pbk/);
  });

  it('hy2 obfs 非 salamander → 剥离混淆不拒节点；salamander 缺 obfs-password → 拒（强制混淆裸连必死）', () => {
    const c = parser.parseUrl('hysteria2://pw@a.com:443?obfs=faketype&obfs-password=x#n');
    expect(c.hysteria2Settings?.obfs).toBeUndefined();
    expect(() => parser.parseUrl('hysteria2://pw@a.com:443?obfs=salamander#n')).toThrow(
      /缺少 obfs-password/
    );
  });

  it('vmess net=httpupgrade → 一等承载（v2rayN 在野形态，sing-box 支持）', () => {
    const url =
      'vmess://' +
      Buffer.from(
        JSON.stringify({
          v: '2',
          ps: 'V',
          add: 'x.com',
          port: '443',
          id: 'uid',
          net: 'httpupgrade',
          path: '/up',
          host: 'h.com',
        })
      ).toString('base64');
    const c = parser.parseUrl(url);
    expect(c.network).toBe('httpupgrade');
    expect(c.wsSettings).toEqual({ path: '/up', headers: { Host: 'h.com' } });
  });

  it('裸 IPv6 无端口 → 整段加括号不截地址（端口缺省 443，与域名无端口同语义）', () => {
    const c = parser.parseUrl('vless://uuid-1@2001:db8::1?encryption=none#v6np');
    expect(c.address).toBe('2001:db8::1');
    expect(c.port).toBe(443);
  });
});

// ── 复审轮2 补测：vmess httpupgrade 往返对称 / SIP002 裸 IPv6 + plugin ──
describe('复审轮2 边界', () => {
  it('vmess httpupgrade 往返不动点（generate 回写 path/host，不退化空值）', () => {
    const url =
      'vmess://' +
      Buffer.from(
        JSON.stringify({
          v: '2',
          ps: 'VHU',
          add: 'x.com',
          port: '443',
          id: 'uid',
          aid: '0',
          scy: 'auto',
          net: 'httpupgrade',
          path: '/up',
          host: 'cdn.example.com',
          tls: 'tls',
          sni: 's.com',
          fp: 'chrome',
        })
      ).toString('base64');
    const first = parser.parseUrl(url);
    expect(first.wsSettings).toEqual({ path: '/up', headers: { Host: 'cdn.example.com' } });
    const second = parser.parseUrl(parser.generateUrl(first));
    expect(second.network).toBe('httpupgrade');
    expect(second.wsSettings).toEqual({ path: '/up', headers: { Host: 'cdn.example.com' } });
  });

  it('SIP002 裸 IPv6 + /?plugin= 形态：/ 前截断 hostPort，端口拆分不受破坏', () => {
    const b64 = Buffer.from('aes-128-gcm:pw').toString('base64');
    const c = parser.parseUrl(
      `ss://${b64}@2001:db8::1:8388/?plugin=obfs-local%3Bobfs%3Dhttp#ss-v6-plugin`
    );
    expect(c.address).toBe('2001:db8::1');
    expect(c.port).toBe(8388);
    expect(c.shadowsocksSettings?.plugin).toBe('obfs-local');
  });
});

// ── Snell（一等公民，issue #146）：事实形态分享链 parse/generate ──
describe('Snell', () => {
  it('v4 + obfs http 特征', () => {
    const c = parser.parseUrl(
      'snell://psk-secret@s.example.com:443?version=4&obfs=http&obfs-host=bing.com&reuse=1#snell-4'
    );
    expect(c.protocol).toBe('snell');
    expect(c.password).toBe('psk-secret');
    expect(c.snellSettings).toEqual({
      version: 4,
      obfsMode: 'http',
      obfsHost: 'bing.com',
      reuse: true,
    });
    expect(c.name).toBe('snell-4');
  });

  it('version 缺省 = 4', () => {
    const c = parser.parseUrl('snell://pw@s.example.com:443#n');
    expect(c.snellSettings?.version).toBe(4);
  });

  it('v6 特征（mode/network/userkey）', () => {
    const c = parser.parseUrl(
      'snell://pw@s.example.com:443?version=6&mode=unsafe-raw&network=tcp&userkey=uk#snell-6'
    );
    expect(c.snellSettings).toEqual({
      version: 6,
      mode: 'unsafe-raw',
      network: 'tcp',
      userkey: 'uk',
    });
  });

  it('缺 psk / 版本非 4|6 / obfs=tls（sing-box 无能力）→ 整节点拒绝', () => {
    expect(() => parser.parseUrl('snell://@s.example.com:443?version=4')).toThrow(/缺少 psk/);
    expect(() => parser.parseUrl('snell://pw@s.example.com:443?version=3')).toThrow(/仅支持 4\/6/);
    expect(() => parser.parseUrl('snell://pw@s.example.com:443?version=4&obfs=tls')).toThrow(
      /obfs 不受支持/
    );
  });

  it('往返不动点 v4 obfs http', () =>
    void expectRoundTripStable(
      'snell://psk-secret@s.example.com:443?version=4&obfs=http&obfs-host=bing.com&reuse=1#snell-4'
    ));

  it('往返不动点 v6 mode/userkey', () =>
    void expectRoundTripStable(
      'snell://pw@s.example.com:443?version=6&mode=unsafe-raw&network=tcp&userkey=uk#snell-6'
    ));
});

// ── Snell review 补测：psk 特殊字符往返 / v6+obfs 拒绝 ──
describe('Snell — review 边界补测', () => {
  it('psk 含 : @ # ?（URL 编码）→ 解析还原 + 往返不动点', () => {
    const psk = 'p:a@b#c?d';
    const url = `snell://${encodeURIComponent(psk)}@s.example.com:443?version=4#sp`;
    const c = parser.parseUrl(url);
    expect(c.password).toBe(psk);
    void expectRoundTripStable(url);
  });

  it('psk 含未编码 :（URL 引擎拆 username:password）→ 两段拼回不截断', () => {
    const c = parser.parseUrl('snell://part1:part2@s.example.com:443?version=4#n');
    expect(c.password).toBe('part1:part2');
  });

  it('v6 + obfs → 拒绝（sing-box v6 无混淆能力）', () => {
    expect(() => parser.parseUrl('snell://pw@s.example.com:443?version=6&obfs=http#n')).toThrow(
      /obfs 不受支持/
    );
  });

  it('空白 psk → 拒绝（trim 语义与 completeness 闸门对齐）', () => {
    expect(() => parser.parseUrl('snell://%20@s.example.com:443?version=4#n')).toThrow(/缺少 psk/);
  });
});

describe('ALPN 归一化（逗号串 → 数组统一 dedupeTrim：修剪空白 + 保序去重 + 丢弃空串）', () => {
  const mkVmess = (data: Record<string, unknown>) =>
    'vmess://' + Buffer.from(JSON.stringify(data)).toString('base64');

  // parseTlsSettings 口径（VLESS / Trojan / Hysteria2 共用）——用 VLESS 覆盖。
  describe('VLESS / Trojan / Hy2（parseTlsSettings）', () => {
    it('带前导空格逗号串 → 逐项 trim（h2, http/1.1 不再产出 " http/1.1"）', () => {
      const c = parser.parseUrl(
        'vless://11111111-1111-1111-1111-111111111111@a.example.com:443?security=tls&sni=s.com&' +
          `alpn=${encodeURIComponent('h2, http/1.1')}#n`
      );
      expect(c.tlsSettings?.alpn).toEqual(['h2', 'http/1.1']);
    });

    it('多值保序 + 去重（重复项按首次出现位置保留）', () => {
      const c = parser.parseUrl(
        'trojan://pw@c.example.com:443?security=tls&sni=t.com&' +
          `alpn=${encodeURIComponent('h2,h3,h2, http/1.1')}#n`
      );
      expect(c.tlsSettings?.alpn).toEqual(['h2', 'h3', 'http/1.1']);
    });

    it('纯空白输入 → 空数组而非 [\'\']', () => {
      const c = parser.parseUrl(
        'hysteria2://pw@d.example.com:8443?sni=h.com&' + `alpn=${encodeURIComponent('  ,  ')}#n`
      );
      expect(c.tlsSettings?.alpn).toEqual([]);
    });
  });

  // TUIC 独立解析路径（parseTuic）。
  describe('TUIC（parseTuic）', () => {
    it('带空格逗号串 → 保序 trim', () => {
      const c = parser.parseUrl(
        `tuic://uuid-t:pw@g.example.com:443?alpn=${encodeURIComponent('h3, h2')}&sni=tu.com#n`
      );
      expect(c.tlsSettings?.alpn).toEqual(['h3', 'h2']);
    });
  });

  // VMess 独立解析路径（parseVmess）：alpn 可为逗号串或数组。
  describe('VMess（parseVmess）', () => {
    const base = {
      v: '2',
      ps: 'V',
      add: 'i.example.com',
      port: '443',
      id: 'uid',
      net: 'tcp',
      tls: 'tls',
      sni: 's.com',
    };

    it('逗号串带空格 → trim + 保序去重', () => {
      const c = parser.parseUrl(mkVmess({ ...base, alpn: 'h2, http/1.1, h2' }));
      expect(c.tlsSettings?.alpn).toEqual(['h2', 'http/1.1']);
    });

    it('数组带空格元素 → 逐项 trim', () => {
      const c = parser.parseUrl(mkVmess({ ...base, alpn: ['h2', ' http/1.1'] }));
      expect(c.tlsSettings?.alpn).toEqual(['h2', 'http/1.1']);
    });
  });
});
