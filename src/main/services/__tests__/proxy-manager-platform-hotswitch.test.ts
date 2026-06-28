/**
 * ProxyManager 平台差异热切换单测：winTunBlocksHotSwitch + planHotSwitch 的 Windows TUN 拦截分支。
 *
 * winTunBlocksHotSwitch（ProxyManager:1208 private）逻辑：
 *   - 非 win32 或 非 tun 模式 → false（放行热切换）
 *   - win32 + tun + stack!=='system'（如 gvisor）→ true（拦截，退回重启）
 *   - win32 + tun + stack='system'（默认）→ false（放行）
 *
 * planHotSwitch 在 winTunBlocksHotSwitch 返回 true 时直接 kind='none'（退回重启）。
 *
 * 关键工程点：process.platform 是 Node 全局只读属性，跨测试须 mock 后还原（afterEach），
 * 否则污染同进程其他 suite（configGenerationNorm 等不依赖平台但共享 process 对象）。
 *
 * 私有方法经 `(svc as any).method()` 直调，不启动 sing-box（构造仅注入 configPath/singboxPath）。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-plat-test-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: (...args: any[]) => mockExecFile(...args),
}));

import { ProxyManager } from '../ProxyManager';
import type { UserConfig, ServerConfig } from '../../../shared/types';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// --- process.platform mock 工具（mock 后须还原，防污染）----------------------------

const REAL_PLATFORM = process.platform;
let mockPlatformActive = false;

/** 临时覆盖 process.platform；afterEach 自动还原。 */
function setPlatform(p: string) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true, writable: true });
  mockPlatformActive = true;
}

afterEach(() => {
  if (mockPlatformActive) {
    Object.defineProperty(process, 'platform', {
      value: REAL_PLATFORM,
      configurable: true,
      writable: true,
    });
    mockPlatformActive = false;
  }
});

// --- 构造 + 数据 fixture ---------------------------------------------------------

function makeSvc() {
  const configPath = path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`);
  const svc: any = new ProxyManager(undefined, undefined, configPath, '/fake/sing-box');
  return svc;
}

const NODE_A = 'node-a';
const NODE_B = 'node-b';

function servers(): ServerConfig[] {
  return [
    {
      id: NODE_A,
      name: 'A',
      protocol: 'shadowsocks',
      address: '1.1.1.1',
      port: 8388,
    } as unknown as ServerConfig,
    {
      id: NODE_B,
      name: 'B',
      protocol: 'shadowsocks',
      address: '2.2.2.2',
      port: 8388,
    } as unknown as ServerConfig,
  ];
}

/**
 * 构造 config。tun 模式 + 可控 tunConfig.stack。
 * selectedServerId 注入使 planHotSwitch 有可热切的全局节点（验证放行分支真正进 global）。
 */
function makeConfig(opts?: {
  proxyModeType?: UserConfig['proxyModeType'];
  tunStack?: string;
  selectedServerId?: string | null;
}): UserConfig {
  return {
    servers: servers(),
    selectedServerId: opts?.selectedServerId ?? NODE_A,
    proxyMode: 'smart',
    proxyModeType: opts?.proxyModeType ?? 'systemProxy',
    tunConfig: { enable: true, stack: opts?.tunStack ?? 'system' } as any,
    customRules: [],
    appRules: [],
    autoStart: false,
    silentStart: false,
    autoConnect: false,
    minimizeToTray: false,
    autoCheckUpdate: false,
    autoLightweightMode: false,
    autoUpdateSubscriptionOnStart: false,
    socksPort: 1080,
    httpPort: 1081,
    logLevel: 'info',
  } as UserConfig;
}

// ============================================================================
// 一、winTunBlocksHotSwitch（私有，三平台 × 模式 × stack 矩阵）
// ============================================================================

describe('ProxyManager.winTunBlocksHotSwitch', () => {
  it('win32 + tun + stack=gvisor → true（拦截热切换，退回重启）', () => {
    setPlatform('win32');
    const svc = makeSvc();
    const cfg = makeConfig({ proxyModeType: 'tun', tunStack: 'gvisor' });
    expect(svc.winTunBlocksHotSwitch(cfg)).toBe(true);
  });

  it('win32 + tun + stack=system（默认）→ false（放行）', () => {
    setPlatform('win32');
    const svc = makeSvc();
    const cfg = makeConfig({ proxyModeType: 'tun', tunStack: 'system' });
    expect(svc.winTunBlocksHotSwitch(cfg)).toBe(false);
  });

  it('win32 + tun + tunConfig 缺省 stack（undefined）→ false（默认 system 放行）', () => {
    setPlatform('win32');
    const svc = makeSvc();
    const cfg = makeConfig({ proxyModeType: 'tun' });
    // 删 stack 模拟旧 config 无此字段 → winTunStack 默认 'system'
    (cfg.tunConfig as any).stack = undefined;
    expect(svc.winTunBlocksHotSwitch(cfg)).toBe(false);
  });

  it('win32 + systemProxy（非 tun）→ false（非 tun 不拦）', () => {
    setPlatform('win32');
    const svc = makeSvc();
    const cfg = makeConfig({ proxyModeType: 'systemProxy' });
    expect(svc.winTunBlocksHotSwitch(cfg)).toBe(false);
  });

  it('win32 + tun + stack=mixed → true（非 system 一律拦）', () => {
    setPlatform('win32');
    const svc = makeSvc();
    const cfg = makeConfig({ proxyModeType: 'tun', tunStack: 'mixed' });
    expect(svc.winTunBlocksHotSwitch(cfg)).toBe(true);
  });

  it('win32 + tun + stack=auto → false（Auto 解析为 system，迁移后默认须放行；防回归）', () => {
    setPlatform('win32');
    const svc = makeSvc();
    const cfg = makeConfig({ proxyModeType: 'tun', tunStack: 'auto' });
    // 治本：guard 必须 resolveTunStack 后再判，不能按裸 'auto'!=='system' 误退重启
    expect(svc.winTunBlocksHotSwitch(cfg)).toBe(false);
  });

  it('darwin + tun + stack=gvisor → false（非 Win 不拦）', () => {
    setPlatform('darwin');
    const svc = makeSvc();
    const cfg = makeConfig({ proxyModeType: 'tun', tunStack: 'gvisor' });
    expect(svc.winTunBlocksHotSwitch(cfg)).toBe(false);
  });

  it('darwin + tun + stack=system → false', () => {
    setPlatform('darwin');
    const svc = makeSvc();
    const cfg = makeConfig({ proxyModeType: 'tun', tunStack: 'system' });
    expect(svc.winTunBlocksHotSwitch(cfg)).toBe(false);
  });

  it('linux + tun + stack=gvisor → false（非 Win 不拦）', () => {
    setPlatform('linux');
    const svc = makeSvc();
    const cfg = makeConfig({ proxyModeType: 'tun', tunStack: 'gvisor' });
    expect(svc.winTunBlocksHotSwitch(cfg)).toBe(false);
  });

  it('linux + systemProxy → false', () => {
    setPlatform('linux');
    const svc = makeSvc();
    const cfg = makeConfig({ proxyModeType: 'systemProxy' });
    expect(svc.winTunBlocksHotSwitch(cfg)).toBe(false);
  });
});

// ============================================================================
// 二、planHotSwitch 的 winTun 拦截端到端（kind='none'）
// ============================================================================

describe('ProxyManager.planHotSwitch winTun 拦截', () => {
  /**
   * planHotSwitch 需 currentConfig（old）+ currentIdToTagMap 已就位才会进到 winTun 判定。
   * norm 等价前提：old 与 next 结构完全一致（proxyModeType/tunStack/customRules 等都不变），
   * 仅 selectedServerId 变（A→B）→ 放行到 winTun 分支。
   * 注入 currentIdToTagMap 使 NODE_B 可解析（验证放行分支确实产 global PUT，对照拦截分支 none）。
   *
   * @param mode  old/next 共用的 proxyModeType（tun 或 systemProxy）
   * @param stack old/next 共用的 tunConfig.stack
   */
  function setupForGlobalSwitch(svc: any, mode: 'tun' | 'systemProxy', stack: string) {
    svc.currentConfig = makeConfig({
      proxyModeType: mode,
      tunStack: stack,
      selectedServerId: NODE_A,
    });
    svc.currentIdToTagMap = new Map([
      [NODE_A, 'tagA'],
      [NODE_B, 'tagB'],
    ]);
  }

  it('win32 + tun + gvisor：换全局节点 → kind="none"（退回重启，不热切换）', () => {
    setPlatform('win32');
    const svc = makeSvc();
    setupForGlobalSwitch(svc, 'tun', 'gvisor');
    const next = makeConfig({ proxyModeType: 'tun', tunStack: 'gvisor', selectedServerId: NODE_B });
    const plan = svc.planHotSwitch(next);
    expect(plan.kind).toBe('none');
    expect(plan.puts).toEqual([]);
  });

  it('win32 + tun + system：换全局节点 → kind="global"（放行热切换）', () => {
    setPlatform('win32');
    const svc = makeSvc();
    setupForGlobalSwitch(svc, 'tun', 'system');
    const next = makeConfig({ proxyModeType: 'tun', tunStack: 'system', selectedServerId: NODE_B });
    const plan = svc.planHotSwitch(next);
    expect(plan.kind).toBe('global');
    expect(plan.puts).toEqual([{ selectorTag: 'proxy-selector', memberTag: 'tagB' }]);
  });

  it('win32 + systemProxy：换全局节点 → kind="global"（非 tun 不受 winTun 约束）', () => {
    setPlatform('win32');
    const svc = makeSvc();
    setupForGlobalSwitch(svc, 'systemProxy', 'system');
    const next = makeConfig({
      proxyModeType: 'systemProxy',
      tunStack: 'system',
      selectedServerId: NODE_B,
    });
    const plan = svc.planHotSwitch(next);
    expect(plan.kind).toBe('global');
  });

  it('darwin + tun + gvisor：换全局节点 → kind="global"（非 Win 放行）', () => {
    setPlatform('darwin');
    const svc = makeSvc();
    setupForGlobalSwitch(svc, 'tun', 'gvisor');
    const next = makeConfig({ proxyModeType: 'tun', tunStack: 'gvisor', selectedServerId: NODE_B });
    const plan = svc.planHotSwitch(next);
    expect(plan.kind).toBe('global');
  });

  it('linux + tun + gvisor：换全局节点 → kind="global"（非 Win 放行）', () => {
    setPlatform('linux');
    const svc = makeSvc();
    setupForGlobalSwitch(svc, 'tun', 'gvisor');
    const next = makeConfig({ proxyModeType: 'tun', tunStack: 'gvisor', selectedServerId: NODE_B });
    const plan = svc.planHotSwitch(next);
    expect(plan.kind).toBe('global');
  });
});
