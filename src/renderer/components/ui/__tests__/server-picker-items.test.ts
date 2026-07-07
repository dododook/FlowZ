/**
 * server-picker-items 纯映射单测：ServerConfig[] → NodePicker {items, groups} 的分组 / 分组头 / 哨兵 /
 * 延迟徽标 / 地址 / 排除 / 排序 等价矩阵。四处消费方（首页出口 / 规则目标 / 应用分流 / detour）共用此映射，
 * 本测试锁各差异开关的输出，防抽取后回归。
 */
import { buildServerPickerModel, isPickerCandidate, nodeAddress } from '../server-picker-items';
import type { ServerConfig, SubscriptionConfig } from '../../../../shared/types';

const srv = (over: Partial<ServerConfig> & { id: string }): ServerConfig => ({
  name: over.id,
  protocol: 'vless',
  address: `${over.id}.example.com`,
  port: 443,
  ...over,
});

const sub = (id: string, name: string): SubscriptionConfig => ({
  id,
  name,
  url: `https://sub/${id}`,
  autoUpdate: false,
  createdAt: '2026-01-01',
});

const LABELS = { meshLabel: 'MESH', manualLabel: 'MANUAL' };

describe('isPickerCandidate（候选谓词：buildServerPickerModel 入列 + 悬挂检测共用）', () => {
  it('普通节点 → 候选', () => {
    expect(isPickerCandidate(srv({ id: 'a' }))).toBe(true);
  });
  it('excludeId 命中自身 → 非候选', () => {
    expect(isPickerCandidate(srv({ id: 'a' }), 'a')).toBe(false);
    expect(isPickerCandidate(srv({ id: 'a' }), 'b')).toBe(true);
  });
  it('excludeEndpoint 时组网协议 → 非候选（detour 不作前置代理目标）', () => {
    expect(isPickerCandidate(srv({ id: 'w', protocol: 'wireguard' }), undefined, true)).toBe(false);
    expect(isPickerCandidate(srv({ id: 't', protocol: 'tailscale' }), undefined, true)).toBe(false);
    expect(isPickerCandidate(srv({ id: 'v', protocol: 'vless' }), undefined, true)).toBe(true);
  });
  it('detour 悬挂检测：目标已删 / 被组网过滤 → 不在候选（回落直连）', () => {
    const servers = [srv({ id: 'a' }), srv({ id: 'wg', protocol: 'wireguard' })];
    const valid = (id: string) =>
      servers.some((s) => s.id === id && isPickerCandidate(s, 'self', true));
    expect(valid('a')).toBe(true); // 有效前置代理
    expect(valid('wg')).toBe(false); // 组网协议被排除 → 悬挂
    expect(valid('deleted')).toBe(false); // 已删除 → 悬挂
    expect(valid('self')).toBe(false); // 自身被排除
  });
});

describe('nodeAddress', () => {
  it('有地址 + 端口 → addr:port', () =>
    expect(nodeAddress(srv({ id: 'a', address: 'h', port: 8443 }))).toBe('h:8443'));
  it('端口为 0（falsy）→ 仅地址', () =>
    expect(nodeAddress(srv({ id: 'a', address: 'h', port: 0 }))).toBe('h'));
  it('无地址 → undefined', () =>
    expect(nodeAddress(srv({ id: 'a', address: '' }))).toBeUndefined());
});

describe('buildServerPickerModel — 分组头（多来源才显）', () => {
  it('单一来源（仅自建）→ 无分组头，items 无 groupId', () => {
    const { items, groups } = buildServerPickerModel({
      servers: [srv({ id: 'a' }), srv({ id: 'b' })],
      subscriptions: [],
      latencyMap: {},
      ...LABELS,
    });
    expect(groups).toEqual([]);
    expect(items.map((i) => i.groupId)).toEqual([undefined, undefined]);
  });

  it('多来源（自建 + 订阅）→ 分组头 manual/sub 名，items 带 groupId', () => {
    const { items, groups } = buildServerPickerModel({
      servers: [srv({ id: 'a' }), srv({ id: 's1', subscriptionId: 'sub1' })],
      subscriptions: [sub('sub1', 'My Sub')],
      latencyMap: {},
      ...LABELS,
    });
    expect(groups).toEqual([
      { id: 'manual', label: 'MANUAL' },
      { id: 'sub1', label: 'My Sub' },
    ]);
    expect(items.find((i) => i.id === 'a')?.groupId).toBe('manual');
    expect(items.find((i) => i.id === 's1')?.groupId).toBe('sub1');
  });

  it('组网组分组头用 meshLabel', () => {
    const { groups } = buildServerPickerModel({
      servers: [srv({ id: 'a' }), srv({ id: 'wg', protocol: 'wireguard' })],
      subscriptions: [],
      latencyMap: {},
      ...LABELS,
    });
    expect(groups).toEqual([
      { id: 'manual', label: 'MANUAL' },
      { id: 'mesh', label: 'MESH' },
    ]);
  });
});

describe('buildServerPickerModel — 哨兵', () => {
  it('有哨兵 → 置顶 index 0（direct/follow）', () => {
    const { items } = buildServerPickerModel({
      servers: [srv({ id: 'a' })],
      subscriptions: [],
      latencyMap: {},
      ...LABELS,
      sentinel: { id: '__direct__', name: '直连', role: 'direct' },
    });
    expect(items[0]).toEqual({ id: '__direct__', name: '直连', role: 'direct' });
    expect(items[1].id).toBe('a');
  });

  it('无哨兵 → 首项即节点', () => {
    const { items } = buildServerPickerModel({
      servers: [srv({ id: 'a' })],
      subscriptions: [],
      latencyMap: {},
      ...LABELS,
    });
    expect(items[0].id).toBe('a');
  });
});

describe('buildServerPickerModel — 排除', () => {
  it('excludeId → 排除该节点', () => {
    const { items } = buildServerPickerModel({
      servers: [srv({ id: 'a' }), srv({ id: 'b' })],
      subscriptions: [],
      latencyMap: {},
      ...LABELS,
      excludeId: 'a',
    });
    expect(items.map((i) => i.id)).toEqual(['b']);
  });

  it('excludeEndpoint → 排除组网协议（wireguard/tailscale）', () => {
    const { items } = buildServerPickerModel({
      servers: [srv({ id: 'a' }), srv({ id: 'wg', protocol: 'wireguard' })],
      subscriptions: [],
      latencyMap: {},
      ...LABELS,
      excludeEndpoint: true,
    });
    expect(items.map((i) => i.id)).toEqual(['a']);
  });

  it('excludeEndpoint 缺省 → 保留组网节点', () => {
    const { items } = buildServerPickerModel({
      servers: [srv({ id: 'wg', protocol: 'wireguard' })],
      subscriptions: [],
      latencyMap: {},
      ...LABELS,
    });
    expect(items.map((i) => i.id)).toEqual(['wg']);
  });
});

describe('buildServerPickerModel — 地址 / 延迟 / 排序', () => {
  it('withAddress → 填 addr:port；缺省 → undefined', () => {
    const withAddr = buildServerPickerModel({
      servers: [srv({ id: 'a', address: 'h', port: 80 })],
      subscriptions: [],
      latencyMap: {},
      ...LABELS,
      withAddress: true,
    });
    expect(withAddr.items[0].address).toBe('h:80');
    const noAddr = buildServerPickerModel({
      servers: [srv({ id: 'a', address: 'h', port: 80 })],
      subscriptions: [],
      latencyMap: {},
      ...LABELS,
    });
    expect(noAddr.items[0].address).toBeUndefined();
  });

  it('延迟徽标：latency 取 latencyMap，latencyNA = 不可测（tailscale 不可测 / vless 可测）', () => {
    const { items } = buildServerPickerModel({
      servers: [srv({ id: 'a' }), srv({ id: 'ts', protocol: 'tailscale' })],
      subscriptions: [],
      latencyMap: { a: 42 },
      ...LABELS,
    });
    const a = items.find((i) => i.id === 'a')!;
    const ts = items.find((i) => i.id === 'ts')!;
    expect(a).toMatchObject({ latency: 42, latencyNA: false });
    expect(ts).toMatchObject({ latency: undefined, latencyNA: true });
  });

  it('sortServers → 组内按回调排序', () => {
    const { items } = buildServerPickerModel({
      servers: [srv({ id: 'a' }), srv({ id: 'b' }), srv({ id: 'c' })],
      subscriptions: [],
      latencyMap: {},
      ...LABELS,
      sortServers: (arr) => [...arr].reverse(),
    });
    expect(items.map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });
});
