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
