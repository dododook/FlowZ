/**
 * ExitNodeField 纯映射逻辑单测：排序 / ip·hostName 双匹配 / disabled 判据(豁免当前配置) / note 拼装 / items 首尾哨兵。
 * 组件基于 radix dropdown-menu，本测试只锁与 UI 无关的数据变换（离线安全网，覆盖迁 NodePicker 后的映射契约）。
 */
import type { TailscaleStatusPeer } from '../../../../../shared/tailscale-status';
import {
  CUSTOM,
  NONE,
  matchPeer,
  peerDisabled,
  peerMatches,
  peerNote,
  peersToItems,
  sortPeers,
  type ExitNodeLabels,
} from '../exit-node-field-logic';

const peer = (over: Partial<TailscaleStatusPeer> & { ip: string }): TailscaleStatusPeer => ({
  hostName: '',
  online: false,
  exitNode: false,
  exitNodeOption: false,
  active: false,
  ...over,
});

const labels: ExitNodeLabels = {
  none: '无',
  custom: '自定义',
  inUse: '使用中',
  offline: '离线',
  notAdvertised: '未广告出口',
};

describe('peerMatches（ip / hostName 双匹配单一真值，matchPeer 与 peerDisabled 共用）', () => {
  const p = peer({ ip: '100.0.0.5', hostName: 'nas' });
  it('命中 ip', () => expect(peerMatches(p, '100.0.0.5')).toBe(true));
  it('命中 hostName', () => expect(peerMatches(p, 'nas')).toBe(true));
  it('都不命中 → false', () => expect(peerMatches(p, '100.0.0.6')).toBe(false));
});

describe('sortPeers（可作出口优先 → 在线优先 → 名称；过滤空 ip）', () => {
  it('剔除空 ip', () => {
    const out = sortPeers([peer({ ip: '' }), peer({ ip: '100.0.0.2' })]);
    expect(out.map((p) => p.ip)).toEqual(['100.0.0.2']);
  });

  it('exitNodeOption > online > hostName 逐级排序', () => {
    const out = sortPeers([
      peer({ ip: '100.0.0.4', hostName: 'zeta', online: true, exitNodeOption: false }),
      peer({ ip: '100.0.0.1', hostName: 'beta', online: true, exitNodeOption: true }),
      peer({ ip: '100.0.0.2', hostName: 'alpha', online: false, exitNodeOption: true }),
      peer({ ip: '100.0.0.3', hostName: 'gamma', online: false, exitNodeOption: false }),
    ]);
    // 可作出口(在线 beta → 离线 alpha) → 非出口(在线 zeta → 离线 gamma)
    expect(out.map((p) => p.hostName)).toEqual(['beta', 'alpha', 'zeta', 'gamma']);
  });
});

describe('matchPeer（ip 或 hostName 双匹配）', () => {
  const peers = [peer({ ip: '100.0.0.1', hostName: 'router' })];
  it('命中 ip', () => expect(matchPeer(peers, '100.0.0.1')?.hostName).toBe('router'));
  it('命中 hostName', () => expect(matchPeer(peers, 'router')?.ip).toBe('100.0.0.1'));
  it('空 / 未命中 → undefined', () => {
    expect(matchPeer(peers, '')).toBeUndefined();
    expect(matchPeer(peers, 'nope')).toBeUndefined();
  });
});

describe('peerDisabled（非广告出口禁用；当前配置项豁免）', () => {
  it('广告出口 → 可选', () => {
    expect(peerDisabled(peer({ ip: '100.0.0.1', exitNodeOption: true }), '')).toBe(false);
  });
  it('非广告出口且非当前 → 禁用', () => {
    const p = peer({ ip: '100.0.0.1', hostName: 'nodeA', exitNodeOption: false });
    expect(peerDisabled(p, '')).toBe(true);
  });
  it('非广告出口但为当前已配置(ip 匹配) → 豁免可选', () => {
    expect(peerDisabled(peer({ ip: '100.0.0.1', exitNodeOption: false }), '100.0.0.1')).toBe(false);
  });
  it('非广告出口但为当前已配置(hostName 匹配) → 豁免可选', () => {
    const p = peer({ ip: '100.0.0.1', hostName: 'router', exitNodeOption: false });
    expect(peerDisabled(p, 'router')).toBe(false);
  });
});

describe('peerNote（ip · 状态叠加）', () => {
  it('在线普通节点 → 仅 ip', () => {
    expect(peerNote(peer({ ip: '100.0.0.1', online: true, exitNodeOption: true }), labels)).toBe(
      '100.0.0.1'
    );
  });
  it('使用中 → ip · 使用中', () => {
    const p = peer({ ip: '100.0.0.1', online: true, exitNode: true, exitNodeOption: true });
    expect(peerNote(p, labels)).toBe('100.0.0.1 · 使用中');
  });
  it('离线 + 未广告叠加', () => {
    const p = peer({ ip: '100.0.0.1', online: false, exitNodeOption: false });
    expect(peerNote(p, labels)).toBe('100.0.0.1 · 离线 · 未广告出口');
  });
});

describe('peersToItems（[无, ...设备, 自定义] + 字段映射）', () => {
  const items = peersToItems(
    sortPeers([
      peer({ ip: '100.0.0.1', hostName: 'router', online: true, exitNodeOption: true }),
      peer({ ip: '100.0.0.2', hostName: '', online: false, exitNodeOption: true }),
      peer({ ip: '100.0.0.3', hostName: 'blocked', online: true, exitNodeOption: false }),
    ]),
    '',
    labels
  );

  it('首尾为 NONE / CUSTOM 哨兵', () => {
    expect(items[0]).toMatchObject({ id: NONE, name: '无', role: 'none' });
    expect(items[items.length - 1]).toMatchObject({ id: CUSTOM, name: '自定义' });
  });

  it('设备项字段映射：id=ip、name=hostName||ip、address=ip、dotTone=online?mesh:idle', () => {
    const router = items.find((i) => i.id === '100.0.0.1')!;
    expect(router).toMatchObject({
      id: '100.0.0.1',
      name: 'router',
      address: '100.0.0.1',
      dotTone: 'mesh',
      disabled: false,
    });
    // 无 hostName → name 回退 ip；离线 → idle 点；仍广告出口 → 可选
    const bare = items.find((i) => i.id === '100.0.0.2')!;
    expect(bare).toMatchObject({
      name: '100.0.0.2',
      dotTone: 'idle',
      disabled: false,
    });
    // 非广告出口且非当前配置 → disabled（在线 → 仍 mesh 点）
    const blocked = items.find((i) => i.id === '100.0.0.3')!;
    expect(blocked).toMatchObject({ name: 'blocked', dotTone: 'mesh', disabled: true });
  });

  it('全 disabled 时（无广告出口）设备项均 disabled，哨兵项不禁用', () => {
    const all = peersToItems(
      sortPeers([peer({ ip: '100.0.0.9', hostName: 'blocked', exitNodeOption: false })]),
      '',
      labels
    );
    expect(all.find((i) => i.id === '100.0.0.9')?.disabled).toBe(true);
    expect(all.find((i) => i.id === NONE)?.disabled).toBeUndefined();
    expect(all.find((i) => i.id === CUSTOM)?.disabled).toBeUndefined();
  });
});
