/**
 * ProxyManager 平台差异热切换单测：planHotSwitch 在**任意平台 × 任意 TUN 栈**下都不因平台/栈退回重启。
 *
 * 曾有 `winTunBlocksHotSwitch` guard：Windows TUN 下非 system 栈一律 kind='none'（退回重启），依据是
 * 「gvisor/mixed 未实测，保守起见」。207 补测（wintun + clash_api selector + interrupt_exist_connections
 * + 切换期持续打流）三栈各 3 次切换均 **21/21 零失败、无环路** → guard 依据被推翻，与 Windows 默认栈
 * 改 gvisor 同批删除。留着 guard 等于让全体 Windows 用户换节点从零断流降级成重启核。
 * 注：该补测是**裸 sing-box 最小配置**（无 FakeIP / DNS 劫持 / 规则集 / helper 提权路径），FlowZ 本体的
 * gvisor 换节点回归已于 2026-08-05 在 207 跑完（换节点 ×10 核 PID 不变、175/175 请求成功），
 * 本 suite 只锁「代码层不再按平台/栈拦截」。
 *
 * 本 suite 因此转为**反向回归**：锁住「Win + gvisor/mixed 换节点必须走热切换」，防 guard 以任何形式回潮。
 *
 * process.platform 的 mock 用共享夹具 `./platform-test-utils#withPlatform`（try/finally 还原，不落 afterEach
 * 状态机），不再本文件自造——该夹具的存在意义正是「避免各 *.test.ts 重复定义」。
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
import { withPlatform } from './platform-test-utils';
import type { UserConfig, ServerConfig } from '../../../shared/types';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
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
// 一、guard 已删除：ProxyManager 上不得再存在任何平台/栈维度的热切换拦截私有方法
// ============================================================================

describe('winTunBlocksHotSwitch 已删除', () => {
  /**
   * 名字级断言看着笨，但它是**唯一**能防「guard 被原样恢复」的静态锁：删除是本批的核心改动，
   * 行为断言（下方 suite）只能证明当前实现放行，无法阻止有人重新引入同名方法再在别处调用。
   */
  it('私有方法不复存在（防 guard 原样回潮）', () => {
    const svc = withPlatform('win32', () => makeSvc());
    expect(svc.winTunBlocksHotSwitch).toBeUndefined();
  });
});

// ============================================================================
// 二、planHotSwitch 端到端：平台 × 栈全矩阵放行（反向回归）
// ============================================================================

describe('ProxyManager.planHotSwitch 平台/栈矩阵', () => {
  /**
   * planHotSwitch 需 currentConfig（old）+ currentIdToTagMap 已就位才会进到 winTun 判定。
   * norm 等价前提：old 与 next 结构完全一致（proxyModeType/tunStack/customRules 等都不变），
   * 仅 selectedServerId 变（A→B）→ 放行到 winTun 分支。
   * 注入 currentIdToTagMap 使 NODE_B 可解析（验证放行分支确实产 global PUT，对照拦截分支 none）。
   *
   * @param mode  old/next 共用的 proxyModeType（tun 或 systemProxy）
   * @param stack old/next 共用的 tunConfig.stack
   */
  /** 在 platform 下建服务 + 就位 old 态，换全局节点 A→B，返回 plan。 */
  function planGlobalSwitch(
    platform: NodeJS.Platform,
    mode: 'tun' | 'systemProxy',
    stack: string
  ): { kind: string; puts: unknown[] } {
    return withPlatform(platform, () => {
      const svc: any = makeSvc();
      svc.currentConfig = makeConfig({
        proxyModeType: mode,
        tunStack: stack,
        selectedServerId: NODE_A,
      });
      svc.currentIdToTagMap = new Map([
        [NODE_A, 'tagA'],
        [NODE_B, 'tagB'],
      ]);
      return svc.planHotSwitch(
        makeConfig({ proxyModeType: mode, tunStack: stack, selectedServerId: NODE_B })
      );
    });
  }

  const PUT_A_TO_B = [{ selectorTag: 'proxy-selector', memberTag: 'tagB', oldMemberTag: 'tagA' }];

  /**
   * 核心回归：Windows Auto 档现解析为 gvisor（PLATFORM_DEFAULT_STACK.win32）。旧 guard 在此正好命中
   * 「非 system → 退回重启」→ 全体 Windows 用户换节点都要重启核。必须是 global。
   */
  it.each(['gvisor', 'mixed', 'auto', 'system'])(
    'win32 + tun + stack=%s：换全局节点 → kind="global"（guard 已删，不再退回重启）',
    (stack) => {
      const plan = planGlobalSwitch('win32', 'tun', stack);
      expect(plan.kind).toBe('global');
      expect(plan.puts).toEqual(PUT_A_TO_B);
    }
  );

  it('win32 + systemProxy：换全局节点 → kind="global"（非 tun 本就不受约束）', () => {
    expect(planGlobalSwitch('win32', 'systemProxy', 'system').kind).toBe('global');
  });

  it.each(['darwin', 'linux'] as const)('%s + tun + gvisor：换全局节点 → kind="global"', (p) => {
    const plan = planGlobalSwitch(p, 'tun', 'gvisor');
    expect(plan.kind).toBe('global');
    expect(plan.puts).toEqual(PUT_A_TO_B);
  });
});
