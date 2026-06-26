/**
 * Tailscale 状态摊平/映射纯函数单测（L1/L3）。
 * fixture 镜像真核 1.14.0-alpha.34 wire 结构：peers 在 userGroups[].peers（非顶层），self/exitNode 为独立字段。
 */
import {
  flattenTailscalePeers,
  toTailscaleStatusPeers,
  type TailscaleEndpointStatus,
} from '../singbox-api-client';

function makeEp(overrides: Partial<TailscaleEndpointStatus> = {}): TailscaleEndpointStatus {
  return {
    endpointTag: 'Sway-Tailscale',
    backendState: 'Running',
    authURL: '',
    self: {
      hostName: 'SwayMacBook-Pro.local',
      tailscaleIPs: ['100.65.222.71', 'fd7a:115c:a1e0::a732:de48'],
      online: true,
    },
    userGroups: [
      {
        peers: [
          {
            hostName: '4c3c763',
            tailscaleIPs: ['100.112.124.68', 'fd7a:115c::c'],
            online: true,
            stableID: 'n4c',
          },
          {
            hostName: 'iStoreOS-Sway',
            tailscaleIPs: ['100.123.174.107', 'fd7a:115c::2'],
            online: true,
            exitNode: true,
            exitNodeOption: true,
            active: true,
            stableID: 'nGK',
          },
        ],
      },
      {
        peers: [
          {
            hostName: 'FN-EVO2-15E0',
            tailscaleIPs: ['100.74.166.28'],
            online: false,
            stableID: 'nD6',
          },
        ],
      },
    ],
    exitNode: { hostName: 'iStoreOS-Sway', tailscaleIPs: ['100.123.174.107', 'fd7a:115c::2'] },
    ...overrides,
  };
}

describe('flattenTailscalePeers', () => {
  it('摊平 userGroups 各组 peers，且天然排除 self', () => {
    const peers = flattenTailscalePeers(makeEp());
    expect(peers.map((p) => p.hostName)).toEqual(['4c3c763', 'iStoreOS-Sway', 'FN-EVO2-15E0']);
    expect(peers.some((p) => p.hostName === 'SwayMacBook-Pro.local')).toBe(false);
  });

  it('按 stableID 跨组去重', () => {
    const ep = makeEp({
      userGroups: [
        {
          peers: [
            { hostName: 'iStoreOS-Sway', tailscaleIPs: ['100.123.174.107'], stableID: 'nGK' },
          ],
        },
        {
          peers: [
            { hostName: 'iStoreOS-Sway', tailscaleIPs: ['100.123.174.107'], stableID: 'nGK' },
          ],
        },
      ],
    });
    expect(flattenTailscalePeers(ep)).toHaveLength(1);
  });

  it('无 userGroups → 空数组（空安全）', () => {
    expect(flattenTailscalePeers(makeEp({ userGroups: undefined }))).toEqual([]);
    expect(flattenTailscalePeers(makeEp({ userGroups: [] }))).toEqual([]);
    expect(flattenTailscalePeers(makeEp({ userGroups: [{ peers: undefined }] }))).toEqual([]);
  });
});

describe('toTailscaleStatusPeers', () => {
  it('映射 lean 字段 + ip 取 IPv4(100.x) 优先而非 fd7a v6', () => {
    const peers = toTailscaleStatusPeers(makeEp());
    const ts = peers.find((p) => p.hostName === 'iStoreOS-Sway')!;
    expect(ts).toEqual({
      hostName: 'iStoreOS-Sway',
      ip: '100.123.174.107',
      online: true,
      exitNode: true,
      exitNodeOption: true,
      active: true,
    });
  });

  it('缺省布尔位归 false（非出口候选/离线）', () => {
    const peers = toTailscaleStatusPeers(makeEp());
    const fn = peers.find((p) => p.hostName === 'FN-EVO2-15E0')!;
    expect(fn.exitNodeOption).toBe(false);
    expect(fn.online).toBe(false);
    expect(fn.exitNode).toBe(false);
    expect(fn.active).toBe(false);
  });

  it('无 IPv4 时回落首个 IP；无 IP 时空串', () => {
    const ep = makeEp({
      userGroups: [
        {
          peers: [
            { hostName: 'v6only', tailscaleIPs: ['fd7a:115c::9'] },
            { hostName: 'noip', tailscaleIPs: [] },
          ],
        },
      ],
    });
    const peers = toTailscaleStatusPeers(ep);
    expect(peers.find((p) => p.hostName === 'v6only')!.ip).toBe('fd7a:115c::9');
    expect(peers.find((p) => p.hostName === 'noip')!.ip).toBe('');
  });

  it('空 → 空数组', () => {
    expect(toTailscaleStatusPeers(makeEp({ userGroups: [] }))).toEqual([]);
  });
});
