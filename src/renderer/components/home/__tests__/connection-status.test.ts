/**
 * deriveConnectionStatus 纯函数单测（§4 修复 + Tier-2 抽纯函数后的离线安全网）。
 * 锁状态档位矩阵（tun/manual/systemProxy × running/busy/error）+ §4 关键断言：proxyCore.error 原样展示、不按中文文案分类。
 */
import { deriveConnectionStatus, type DeriveStatusInputs } from '../connection-status';

// 取值器：单 key 返原 key；带插值参数则附 JSON，便于断言 key + 插值
const t = (k: string, opts?: Record<string, unknown>) =>
  opts ? `${k}#${JSON.stringify(opts)}` : k;

const base: DeriveStatusInputs = {
  proxyError: null,
  connectionStatus: {
    proxyCore: { running: false },
    proxy: { enabled: false },
    proxyModeType: 'systemProxy',
  },
  configProxyModeType: 'systemProxy',
  proxyBusy: false,
  proxyPhase: 'idle',
};
const d = (over: Partial<DeriveStatusInputs>) => deriveConnectionStatus({ ...base, ...over }, t);

describe('deriveConnectionStatus — 优先级 / 空态', () => {
  it('proxyError 最高优先级', () => {
    const r = d({ proxyError: 'boom' });
    expect(r).toMatchObject({
      label: 'home.statusError',
      variant: 'destructive',
      description: 'boom',
    });
  });

  it('connectionStatus 缺失 → unknown', () => {
    const r = d({ connectionStatus: null });
    expect(r).toMatchObject({
      label: 'home.statusUnknown',
      variant: 'secondary',
      description: 'home.fetchingStatus',
    });
  });
});

describe('deriveConnectionStatus — §4：proxyCore.error 原样展示，不按中文文案重映射', () => {
  it.each([
    '权限不足：需要管理员权限',
    'wintun 驱动加载失败',
    'sing-box.exe 缺失',
    'some english error',
  ])('error=%s → description 原样 + destructive（不再变 i18n key）', (err) => {
    const r = d({
      connectionStatus: {
        proxyCore: { running: false, error: err },
        proxy: { enabled: false },
        proxyModeType: 'tun',
      },
    });
    expect(r.variant).toBe('destructive');
    expect(r.label).toBe('home.statusError');
    expect(r.description).toBe(err); // 关键：原样展示，不再按本地化文案重映射为友好 i18n（原 .includes 分类已删）
  });
});

describe('deriveConnectionStatus — TUN 模式', () => {
  const tun = (over: Partial<DeriveStatusInputs['connectionStatus'] & object> = {}) =>
    d({
      configProxyModeType: 'tun',
      connectionStatus: {
        proxyCore: { running: false },
        proxy: { enabled: false },
        proxyModeType: 'tun',
        ...over,
      },
    });

  it('running → connected + 含 uptime 插值', () => {
    const r = d({
      configProxyModeType: 'tun',
      connectionStatus: {
        proxyCore: { running: true, uptime: 125 },
        proxy: { enabled: false },
        proxyModeType: 'tun',
      },
    });
    expect(r.label).toBe('home.statusConnected');
    expect(r.variant).toBe('default');
    expect(r.description).toContain('home.uptime#{"min":2}'); // floor(125/60)=2
  });

  it('!running + busy + stopping → disconnecting', () => {
    const r = d({
      configProxyModeType: 'tun',
      connectionStatus: {
        proxyCore: { running: false },
        proxy: { enabled: false },
        proxyModeType: 'tun',
      },
      proxyBusy: true,
      proxyPhase: 'stopping',
    });
    expect(r).toMatchObject({
      label: 'home.disconnecting',
      variant: 'secondary',
      description: 'home.stoppingProxy',
    });
  });

  it('!running + busy + starting → connecting/startingTun', () => {
    const r = d({
      configProxyModeType: 'tun',
      connectionStatus: {
        proxyCore: { running: false },
        proxy: { enabled: false },
        proxyModeType: 'tun',
      },
      proxyBusy: true,
      proxyPhase: 'starting',
    });
    expect(r).toMatchObject({ label: 'home.statusConnecting', description: 'home.startingTun' });
  });

  it('!running + !busy → disconnected/tunNotEnabled', () => {
    const r = tun();
    expect(r).toMatchObject({
      label: 'home.statusDisconnected',
      variant: 'outline',
      description: 'home.tunNotEnabled',
    });
  });
});

describe('deriveConnectionStatus — 系统代理 / manual', () => {
  it('running + proxy.enabled → systemProxyConnected', () => {
    const r = d({
      connectionStatus: {
        proxyCore: { running: true },
        proxy: { enabled: true },
        proxyModeType: 'systemProxy',
      },
    });
    expect(r.label).toBe('home.statusConnected');
    expect(r.description).toContain('home.systemProxyConnected');
  });

  it('manual + running → connected + isManualNotice', () => {
    const r = d({
      configProxyModeType: 'manual',
      connectionStatus: {
        proxyCore: { running: true, uptime: 60 },
        proxy: { enabled: false },
        proxyModeType: 'manual',
      },
    });
    expect(r).toMatchObject({
      label: 'home.statusConnected',
      variant: 'default',
      isManualNotice: true,
    });
    expect(r.description).toBe('home.manualMode - home.uptime#{"min":1}');
  });

  it('running + 系统代理未启用 → connecting/singboxRunningEnabling', () => {
    const r = d({
      connectionStatus: {
        proxyCore: { running: true },
        proxy: { enabled: false },
        proxyModeType: 'systemProxy',
      },
    });
    expect(r).toMatchObject({
      label: 'home.statusConnecting',
      variant: 'secondary',
      description: 'home.singboxRunningEnabling',
    });
  });

  it('!running + busy + starting → startingSingbox', () => {
    const r = d({ proxyBusy: true, proxyPhase: 'starting' });
    expect(r).toMatchObject({
      label: 'home.statusConnecting',
      description: 'home.startingSingbox',
    });
  });

  it('!running + busy + stopping → disconnecting/stoppingProxy', () => {
    const r = d({ proxyBusy: true, proxyPhase: 'stopping' });
    expect(r).toMatchObject({ label: 'home.disconnecting', description: 'home.stoppingProxy' });
  });

  it('!running + !busy → disconnected/proxyNotEnabled', () => {
    const r = d({});
    expect(r).toMatchObject({
      label: 'home.statusDisconnected',
      variant: 'outline',
      description: 'home.proxyNotEnabled',
    });
  });
});

describe('deriveConnectionStatus — 模式回落', () => {
  it('config 模式缺失 → 回落 connectionStatus.proxyModeType', () => {
    const r = d({
      configProxyModeType: undefined,
      connectionStatus: {
        proxyCore: { running: true },
        proxy: { enabled: false },
        proxyModeType: 'tun',
      },
    });
    expect(r.description).toContain('home.tunMode'); // 走 TUN 分支（描述以 TUN 文案打头）
    expect(r.label).toBe('home.statusConnected');
  });
});
