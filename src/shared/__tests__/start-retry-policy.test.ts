import { resolveStartRetryBudget } from '../start-retry-policy';
import type { ServerConfig } from '../types';

const base = (over: Partial<ServerConfig> = {}): ServerConfig =>
  ({ id: 's1', name: 'n', protocol: 'tailscale', ...over }) as ServerConfig;

const tsSystem = base({
  protocol: 'tailscale',
  tailscaleSettings: { reverseMesh: true } as ServerConfig['tailscaleSettings'],
});
const tsUserspace = base({
  protocol: 'tailscale',
  tailscaleSettings: { reverseMesh: false } as ServerConfig['tailscaleSettings'],
});
const wgSystem = base({
  id: 's2',
  protocol: 'wireguard',
  wireguardSettings: { reverseMesh: true } as ServerConfig['wireguardSettings'],
});
const plain = base({ id: 's3', protocol: 'vless' });

const DEFAULT_BUDGET = { maxRetries: 2, delay: 2000, exponentialBackoff: true };
const SYSTEM_BUDGET = { maxRetries: 10, delay: 3000, exponentialBackoff: false };

describe('resolveStartRetryBudget', () => {
  it('TUN 模式含 Tailscale system_interface 节点 → 放宽预算(多次/恒定间隔)', () => {
    expect(resolveStartRetryBudget(true, [plain, tsSystem])).toEqual(SYSTEM_BUDGET);
  });

  it('TUN 模式含 WireGuard system_interface 节点 → 放宽预算', () => {
    expect(resolveStartRetryBudget(true, [wgSystem])).toEqual(SYSTEM_BUDGET);
  });

  it('非 TUN 模式即便有 system 节点 → 默认预算(不会建第二张 TUN，无竞态)', () => {
    expect(resolveStartRetryBudget(false, [tsSystem, wgSystem])).toEqual(DEFAULT_BUDGET);
  });

  it('TUN 模式但只有用户态 mesh 节点 → 默认预算', () => {
    expect(resolveStartRetryBudget(true, [tsUserspace, plain])).toEqual(DEFAULT_BUDGET);
  });

  it('空/未定义 servers → 默认预算', () => {
    expect(resolveStartRetryBudget(true, [])).toEqual(DEFAULT_BUDGET);
    expect(resolveStartRetryBudget(true, undefined)).toEqual(DEFAULT_BUDGET);
  });

  it('放宽预算的总时长窗口足够覆盖双 utun 释放(>=25s)', () => {
    const b = resolveStartRetryBudget(true, [tsSystem]);
    // 恒定间隔：总等待 = maxRetries * delay
    expect(b.exponentialBackoff).toBe(false);
    expect(b.maxRetries * b.delay).toBeGreaterThanOrEqual(25_000);
  });
});
