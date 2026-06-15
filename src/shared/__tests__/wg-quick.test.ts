/**
 * parseWgQuickConf 单测（纯函数，无网络/FS）：wg-quick .conf → WireGuard 节点字段。
 * 覆盖：典型配置 / 多 AllowedIPs / IPv6 Endpoint / 注释与空行 / 缺必填回 null / MTU·Keepalive·PSK 可选。
 */
import { parseWgQuickConf } from '../wg-quick';

const TYPICAL = `
# Cloudflare WARP 风格
[Interface]
PrivateKey = aPrivateKeyBase64AAAAAAAAAAAAAAAAAAAAAAAAAAA=
Address = 10.0.0.2/32, fd00::2/128
DNS = 1.1.1.1
MTU = 1280

[Peer]
PublicKey = aPeerPublicKeyBase64BBBBBBBBBBBBBBBBBBBBBBBB=
PresharedKey = aPskBase64CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = engage.cloudflareclient.com:2408
PersistentKeepalive = 25
`;

describe('parseWgQuickConf（wg-quick .conf 解析）', () => {
  it('典型 .conf → 字段齐全、Endpoint 拆为 address/port、DNS 被忽略', () => {
    const r = parseWgQuickConf(TYPICAL);
    expect(r).not.toBeNull();
    expect(r!.address).toBe('engage.cloudflareclient.com');
    expect(r!.port).toBe(2408);
    expect(r!.settings.privateKey).toBe('aPrivateKeyBase64AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    expect(r!.settings.peerPublicKey).toBe('aPeerPublicKeyBase64BBBBBBBBBBBBBBBBBBBBBBBB=');
    expect(r!.settings.preSharedKey).toBe('aPskBase64CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=');
    expect(r!.settings.localAddress).toEqual(['10.0.0.2/32', 'fd00::2/128']);
    expect(r!.settings.allowedIPs).toEqual(['0.0.0.0/0', '::/0']);
    expect(r!.settings.persistentKeepalive).toBe(25);
    expect(r!.settings.mtu).toBe(1280);
  });

  it('IPv6 Endpoint [::1]:port 正确拆分', () => {
    const conf = `[Interface]
PrivateKey = k
Address = 10.0.0.2/32
[Peer]
PublicKey = p
Endpoint = [2606:4700:d0::a29f:c001]:51820
AllowedIPs = 0.0.0.0/0`;
    const r = parseWgQuickConf(conf);
    expect(r).not.toBeNull();
    expect(r!.address).toBe('2606:4700:d0::a29f:c001');
    expect(r!.port).toBe(51820);
  });

  it('IPv4 Endpoint 正确拆分', () => {
    const conf = `[Interface]
PrivateKey = k
Address = 10.0.0.2/32
[Peer]
PublicKey = p
Endpoint = 162.159.192.1:2408
AllowedIPs = 0.0.0.0/0`;
    const r = parseWgQuickConf(conf);
    expect(r!.address).toBe('162.159.192.1');
    expect(r!.port).toBe(2408);
  });

  it('缺 PrivateKey → null', () => {
    const conf = `[Interface]
Address = 10.0.0.2/32
[Peer]
PublicKey = p
Endpoint = h:1`;
    expect(parseWgQuickConf(conf)).toBeNull();
  });

  it('缺 Endpoint → null', () => {
    const conf = `[Interface]
PrivateKey = k
Address = 10.0.0.2/32
[Peer]
PublicKey = p
AllowedIPs = 0.0.0.0/0`;
    expect(parseWgQuickConf(conf)).toBeNull();
  });

  it('缺 Address → null', () => {
    const conf = `[Interface]
PrivateKey = k
[Peer]
PublicKey = p
Endpoint = h:1`;
    expect(parseWgQuickConf(conf)).toBeNull();
  });

  it('非法端口（Endpoint 无端口）→ null', () => {
    const conf = `[Interface]
PrivateKey = k
Address = 10.0.0.2/32
[Peer]
PublicKey = p
Endpoint = nohostport`;
    expect(parseWgQuickConf(conf)).toBeNull();
  });

  it('可选字段缺省：无 PSK/Keepalive/MTU → 对应字段 undefined，allowedIPs 缺省不报错', () => {
    const conf = `[Interface]
PrivateKey = k
Address = 10.0.0.2/32
[Peer]
PublicKey = p
Endpoint = h:1`;
    const r = parseWgQuickConf(conf);
    expect(r).not.toBeNull();
    expect(r!.settings.preSharedKey).toBeUndefined();
    expect(r!.settings.persistentKeepalive).toBeUndefined();
    expect(r!.settings.mtu).toBeUndefined();
    expect(r!.settings.allowedIPs).toBeUndefined();
  });

  it('空/非字符串输入 → null', () => {
    expect(parseWgQuickConf('')).toBeNull();
    expect(parseWgQuickConf(null)).toBeNull();
    expect(parseWgQuickConf(undefined)).toBeNull();
    expect(parseWgQuickConf('not a conf')).toBeNull();
  });
});
