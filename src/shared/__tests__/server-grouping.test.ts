import { groupServersBySubscription } from '../server-grouping';
import type { ServerConfig, SubscriptionConfig } from '../types';

const srv = (id: string, protocol: string, subscriptionId?: string): ServerConfig =>
  ({ id, name: id, protocol, address: '1.2.3.4', port: 1, subscriptionId }) as ServerConfig;

const sub = (id: string, name: string): SubscriptionConfig => ({ id, name }) as SubscriptionConfig;

describe('groupServersBySubscription（自建 / 组网 / 订阅 单一真值）', () => {
  it('自建拆出组网：endpoint(wireguard/tailscale) → mesh，其余 → manual；顺序 manual→mesh→sub', () => {
    const groups = groupServersBySubscription(
      [
        srv('v', 'vless'),
        srv('wg', 'wireguard'),
        srv('ts', 'tailscale'),
        srv('s1', 'vmess', 'subA'),
      ],
      [sub('subA', '订阅A')]
    );
    expect(groups.map((g) => g.id)).toEqual(['manual', 'mesh', 'subA']);
    expect(groups.find((g) => g.id === 'manual')!.servers.map((s) => s.id)).toEqual(['v']);
    const mesh = groups.find((g) => g.isMesh)!;
    expect(mesh.id).toBe('mesh');
    expect(mesh.servers.map((s) => s.id).sort()).toEqual(['ts', 'wg']);
    expect(groups.find((g) => g.id === 'subA')!.servers.map((s) => s.id)).toEqual(['s1']);
  });

  it('WARP(wireguard) 归组网，custom 归自建', () => {
    const groups = groupServersBySubscription([srv('warp', 'wireguard'), srv('c', 'custom')]);
    expect(groups.find((g) => g.isMesh)!.servers.map((s) => s.id)).toEqual(['warp']);
    expect(groups.find((g) => g.id === 'manual')!.servers.map((s) => s.id)).toEqual(['c']);
  });

  it('仅代理节点 → 无组网组；仅组网节点 → 无自建组', () => {
    expect(groupServersBySubscription([srv('v', 'vless')]).map((g) => g.id)).toEqual(['manual']);
    expect(groupServersBySubscription([srv('wg', 'wireguard')]).map((g) => g.id)).toEqual(['mesh']);
  });

  it('孤儿订阅节点(订阅已删) → 按协议并入自建/组网', () => {
    const groups = groupServersBySubscription(
      [srv('orphanWg', 'wireguard', 'gone'), srv('orphanV', 'vless', 'gone')],
      []
    );
    expect(groups.find((g) => g.isMesh)!.servers.map((s) => s.id)).toEqual(['orphanWg']);
    expect(groups.find((g) => g.id === 'manual')!.servers.map((s) => s.id)).toEqual(['orphanV']);
  });
});
