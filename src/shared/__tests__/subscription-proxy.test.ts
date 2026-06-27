import { resolveSubscriptionViaProxy, type SubscriptionProxyPolicy } from '../subscription-proxy';

describe('resolveSubscriptionViaProxy（全局三态策略 × per-sub）', () => {
  it.each<[SubscriptionProxyPolicy | undefined, boolean | undefined, boolean]>([
    // follow：按 per-sub
    ['follow', true, true],
    ['follow', false, false],
    ['follow', undefined, false], // per-sub 未设 → 直连（默认关）
    // 未设（默认 follow）：等价 follow
    [undefined, true, true],
    [undefined, false, false],
    [undefined, undefined, false],
    // proxy：强制经代理，忽略 per-sub
    ['proxy', false, true],
    ['proxy', undefined, true],
    ['proxy', true, true],
    // direct：强制直连，忽略 per-sub
    ['direct', true, false],
    ['direct', undefined, false],
    ['direct', false, false],
  ])('policy=%s sub=%s → %s', (policy, sub, expected) => {
    expect(resolveSubscriptionViaProxy(policy, sub)).toBe(expected);
  });
});
