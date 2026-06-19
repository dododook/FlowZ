/**
 * #57 resolve-ahead 集成：generateSingBoxConfig 把 this.lastResolvedHosts 透传到节点 outbound.server。
 * 本项目铁律：DNS runtime 改动须以生成物验证。这里验证「线」——预解析表填充时 server=IP 且 SNI=原域名；
 * 空表（默认/未启动/snapshot 路径）时 server 仍=域名（逐字节回现状由 config-snapshot.test 另行守护）。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-resolve-ahead-'));
jest.mock('electron', () => ({
  app: {
    getPath: () => TMP,
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => TMP,
  },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ProxyManager } from '../ProxyManager';
import { buildFixtures, NODE_A, NODE_B, NODE_IP } from './dns-resolver-fixtures';

type AnyCfg = any;

const IP_A = '203.0.113.10';
const IP_B = '203.0.113.11';

function tunSmartConfig() {
  return buildFixtures().find((f) => f.name === 'tun-smart__auto')!.config;
}
function outboundByTag(cfg: AnyCfg, tag: string): AnyCfg {
  return (cfg.outbounds as AnyCfg[]).find((o) => o.tag === tag);
}

describe('#57 resolve-ahead：lastResolvedHosts → outbound.server（SNI 不变）', () => {
  it('填充预解析表 → 节点 server=IP，tls.server_name 仍=原域名/SNI', () => {
    const pm = new ProxyManager();
    // 私有字段：模拟 startInternal 预解析后的状态（仅解析 server.address，不含 SNI）。
    (pm as unknown as { lastResolvedHosts: Map<string, string> }).lastResolvedHosts = new Map([
      [NODE_A.address, IP_A],
      [NODE_B.address, IP_B],
    ]);
    const cfg = pm.generateSingBoxConfig(tunSmartConfig()) as AnyCfg;

    const a = outboundByTag(cfg, NODE_A.name); // 香港 A（vless + 显式 SNI）
    expect(a.server).toBe(IP_A);
    expect(a.tls.server_name).toBe('sni-a.example.net'); // SNI 未被 IP 覆盖

    const b = outboundByTag(cfg, NODE_B.name); // 美国 B（trojan，SNI=域名）
    expect(b.server).toBe(IP_B);
    expect(b.tls.server_name).toBe('b.trycloudflare.com');

    const ipNode = outboundByTag(cfg, NODE_IP.name); // IP 字面量节点不在表 → 原样
    expect(ipNode.server).toBe('203.0.113.7');
  });

  it('空预解析表（默认）→ 节点 server 仍=原域名（现状）', () => {
    const pm = new ProxyManager(); // lastResolvedHosts 默认空 Map
    const cfg = pm.generateSingBoxConfig(tunSmartConfig()) as AnyCfg;
    expect(outboundByTag(cfg, NODE_A.name).server).toBe(NODE_A.address);
    expect(outboundByTag(cfg, NODE_B.name).server).toBe(NODE_B.address);
  });

  it('部分命中：未解析的节点回退域名，已解析的写 IP', () => {
    const pm = new ProxyManager();
    (pm as unknown as { lastResolvedHosts: Map<string, string> }).lastResolvedHosts = new Map([
      [NODE_A.address, IP_A], // 仅 A 解析成功
    ]);
    const cfg = pm.generateSingBoxConfig(tunSmartConfig()) as AnyCfg;
    expect(outboundByTag(cfg, NODE_A.name).server).toBe(IP_A);
    expect(outboundByTag(cfg, NODE_B.name).server).toBe(NODE_B.address); // B 回退域名
  });

  it('Shadow-TLS：外层 shadowtls 出站 server 也写解析 IP，SNI 仍=原 sni（拨号目标全覆盖）', () => {
    const cfg = JSON.parse(JSON.stringify(tunSmartConfig()));
    const STLS_ADDR = 'stls.example.com';
    cfg.servers.push({
      id: 'node-stls',
      name: 'STLS 节点',
      protocol: 'shadowsocks',
      address: STLS_ADDR,
      port: 443,
      shadowsocksSettings: { method: 'aes-128-gcm', password: 'pw' },
      shadowTlsSettings: { password: 'stlspw', sni: 'sni-stls.example.net', port: 8443 },
    });
    const pm = new ProxyManager();
    (pm as unknown as { lastResolvedHosts: Map<string, string> }).lastResolvedHosts = new Map([
      [STLS_ADDR, '203.0.113.20'],
    ]);
    const sb = pm.generateSingBoxConfig(cfg) as AnyCfg;
    const stls = (sb.outbounds as AnyCfg[]).find((o) => o.type === 'shadowtls');
    expect(stls.server).toBe('203.0.113.20'); // 外层拨号目标 = IP
    expect(stls.tls.server_name).toBe('sni-stls.example.net'); // 身份 SNI 不被 IP 覆盖
  });
});
