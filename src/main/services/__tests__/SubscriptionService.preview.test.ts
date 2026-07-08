/**
 * previewSubscription 单测（node env）：订阅预检——新增订阅前用 URL 拉取+解析但**不写 config**。
 * spy 私有 fetchSubscriptionText 注入网络结果，验证 classifySubscriptionError 分流 + 成功计数：
 *  - HTTP 403 → errorKind='http' / httpStatus=403（正则从 `HTTP Error: 403 ...` 提取）
 *  - ECONNREFUSED → 'refused'（含 err.cause.code 兜底路径）
 *  - ENOTFOUND → 'dns'
 *  - 0 节点 → 'empty'（parseSubscriptionContent throwOnEmpty 抛错经分类器归类）
 *  - 成功 clash yaml → ok + nodeCount（走真实解析器）
 *  - message 脱敏（不落 query token）
 * 只需 electron mock（构造 + 默认 UA）；真实 fetch/DNS 被 spy 绕过，无需 mock。
 */

// ── electron mock（必须在 import SubscriptionService 之前）──────────────────────
jest.mock('electron', () => ({
  app: { getVersion: () => '9.9.9' },
  net: { fetch: jest.fn() },
  session: {
    fromPartition: () => ({ setProxy: jest.fn().mockResolvedValue(undefined), fetch: jest.fn() }),
  },
}));

import { SubscriptionService } from '../SubscriptionService';
import { ProtocolParser } from '../ProtocolParser';

class FakeLog {
  entries: { level: string; message: string }[] = [];
  addLog(level: string, message: string) {
    this.entries.push({ level, message });
  }
}

function newService(): SubscriptionService {
  return new SubscriptionService(new ProtocolParser(), new FakeLog() as never);
}

/** spy 私有 fetchSubscriptionText（返回 { text }）：任务允许 spy 私有方法以绕开真实网络/DNS。 */
function spyFetch(svc: SubscriptionService) {
  return jest.spyOn(
    svc as unknown as {
      fetchSubscriptionText: (...a: unknown[]) => Promise<{ text: string }>;
    },
    'fetchSubscriptionText'
  );
}

describe('previewSubscription — 预检分类（不写 config）', () => {
  it('HTTP 403 → errorKind=http, httpStatus=403', async () => {
    const svc = newService();
    spyFetch(svc).mockRejectedValue(new Error('HTTP Error: 403 Forbidden'));
    const r = await svc.previewSubscription('https://sub.example.com/c', {});
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe('http');
    expect(r.httpStatus).toBe(403);
  });

  it('ECONNREFUSED → errorKind=refused', async () => {
    const svc = newService();
    spyFetch(svc).mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' })
    );
    const r = await svc.previewSubscription('https://sub.example.com/c', {});
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe('refused');
    expect(r.httpStatus).toBeUndefined();
  });

  it('ENOTFOUND → errorKind=dns', async () => {
    const svc = newService();
    spyFetch(svc).mockRejectedValue(
      Object.assign(new Error('getaddrinfo ENOTFOUND sub.example.com'), { code: 'ENOTFOUND' })
    );
    const r = await svc.previewSubscription('https://sub.example.com/c', {});
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe('dns');
  });

  it('code 藏在 err.cause.code → 仍分类（refused）', async () => {
    const svc = newService();
    spyFetch(svc).mockRejectedValue(
      Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    );
    const r = await svc.previewSubscription('https://sub.example.com/c', {});
    expect(r.errorKind).toBe('refused');
  });

  it('成功 clash yaml → ok + nodeCount（走真实解析器，两个节点）', async () => {
    const svc = newService();
    const yaml = [
      'proxies:',
      '  - { name: n1, type: vless, server: 1.2.3.4, port: 443, uuid: u1 }',
      '  - { name: n2, type: trojan, server: 5.6.7.8, port: 443, password: p2 }',
    ].join('\n');
    spyFetch(svc).mockResolvedValue({ text: yaml });
    const r = await svc.previewSubscription('https://sub.example.com/c', { viaProxy: false });
    expect(r.ok).toBe(true);
    expect(r.nodeCount).toBe(2);
    expect(r.errorKind).toBeUndefined();
  });

  it('解析 0 节点 → errorKind=empty（throwOnEmpty 抛错经分类器归类）', async () => {
    const svc = newService();
    // 全不支持类型 → parseSubscriptionContent(throwOnEmpty:true) 抛 "0 个可用节点"。
    const yaml = ['proxies:', '  - { name: bad, type: ssr, server: 1.1.1.1, port: 1 }'].join('\n');
    spyFetch(svc).mockResolvedValue({ text: yaml });
    const r = await svc.previewSubscription('https://sub.example.com/c', {});
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe('empty');
  });

  it('message 已脱敏（不含 query token）', async () => {
    const svc = newService();
    spyFetch(svc).mockRejectedValue(new Error('boom https://x.example.com/p?token=SECRET123'));
    const r = await svc.previewSubscription('https://sub.example.com/c?token=SECRET123', {});
    expect(r.ok).toBe(false);
    expect(r.message ?? '').not.toContain('SECRET123');
  });

  it('缺省 opts（无 userAgent/viaProxy）不抛，走默认 UA', async () => {
    const svc = newService();
    const fetchSpy = spyFetch(svc);
    fetchSpy.mockResolvedValue({
      text: 'proxies:\n  - { name: n, type: vless, server: 1.2.3.4, port: 443, uuid: u }',
    });
    const r = await svc.previewSubscription('https://sub.example.com/c', {});
    expect(r.ok).toBe(true);
    // 第 3 个实参为 userAgent：缺省时用 defaultSubscriptionUserAgent() = FlowZ/9.9.9（electron mock 版本）。
    expect(fetchSpy.mock.calls[0][2]).toBe('FlowZ/9.9.9');
  });
});
