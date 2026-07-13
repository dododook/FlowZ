/**
 * bug#5 丢失更新修复：lifecycle 在飞（start/stop/restart 执行窗口，lifecycleDepth>0）时到达的 switchMode 配置变更
 * 不丢弃、暂存 pendingSwitchConfig，endLifecycleOp 回 depth 0（kind≠stop）时重放一次对账；stop 终态丢弃（已落盘）。
 * 根因：restart 的 stop→spawn 空窗 singboxPid=null，旧 switchMode「未运行」早退把变更静默丢给盘、对运行核永久丢失
 * → 核起于陈旧 fallback 快照（出口≠UI 选中）。私有字段/方法经 `(svc as any)` 直调。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-lifecycle-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
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

function makeSvc() {
  const configPath = path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`);
  return new ProxyManager(undefined, undefined, configPath, '/fake/sing-box') as any;
}

const ss = (id: string): ServerConfig =>
  ({ id, name: id, protocol: 'shadowsocks', address: '1.1.1.1', port: 8388 }) as any;
const cfg = (servers: ServerConfig[]): UserConfig =>
  ({ servers, selectedServerId: servers[0]?.id ?? null, proxyMode: 'smart' }) as any;

describe('ProxyManager bug#5 lifecycle 窗口丢失更新修复', () => {
  it('isLifecycleBusy 反映 lifecycleDepth', () => {
    const svc = makeSvc();
    expect(svc.isLifecycleBusy()).toBe(false);
    svc.lifecycleDepth = 1;
    expect(svc.isLifecycleBusy()).toBe(true);
  });

  it('depth>0：switchMode 暂存变更、不改 currentConfig（不丢弃、不早退）；endLifecycleOp(start) 回 0 重放', async () => {
    const svc = makeSvc();
    const cfgA = cfg([ss('A')]);
    const cfgB = cfg([ss('A'), ss('B')]);
    svc.singboxPid = 1234; // 模拟核在跑（否则走「未运行」早退——本修复正是让 busy 优先于它）
    svc.currentConfig = cfgA;
    svc.lifecycleDepth = 1; // 模拟 restart 在飞（stop→spawn 空窗）

    await svc.switchMode(cfgB);
    expect(svc.pendingSwitchConfig).toBe(cfgB); // 暂存，未丢
    expect(svc.currentConfig).toBe(cfgA); // currentConfig 未被推进（防在飞 reassert 读到与 tag map 不一致的 selected）

    // drain：回 depth 0 时重放暂存变更对账。
    const spy = jest.spyOn(svc, 'switchMode').mockResolvedValue(undefined);
    svc.endLifecycleOp('start');
    expect(svc.pendingSwitchConfig).toBeNull(); // 已消费
    expect(spy).toHaveBeenCalledWith(cfgB); // 重放
  });

  it('depth>0：无核在跑时（未运行）busy 仍优先暂存——不走「未运行只更新配置」早退', async () => {
    const svc = makeSvc();
    const cfgB = cfg([ss('A'), ss('B')]);
    // singboxPid/singboxProcess 均空（未运行），但 lifecycle 在飞（如 start 腿执行中，核尚未 spawn）
    svc.lifecycleDepth = 1;
    await svc.switchMode(cfgB);
    expect(svc.pendingSwitchConfig).toBe(cfgB); // 暂存（而非走「未运行 → currentConfig=cfgB」早退语义）
    expect(svc.currentConfig).not.toBe(cfgB); // 未被未运行早退设成 cfgB
  });

  it('endLifecycleOp(stop)：丢弃暂存变更（已落盘，勿重放拉起核）', () => {
    const svc = makeSvc();
    const cfgB = cfg([ss('A'), ss('B')]);
    svc.pendingSwitchConfig = cfgB;
    svc.lifecycleDepth = 1;
    const spy = jest.spyOn(svc, 'switchMode').mockResolvedValue(undefined);
    svc.endLifecycleOp('stop');
    expect(svc.pendingSwitchConfig).toBeNull(); // 丢弃
    expect(spy).not.toHaveBeenCalled(); // 不重放
  });

  it('review#1：全等 config → switchMode 短路（不 planHotSwitch/不重启），即使 degraded 也不自触发重启循环', async () => {
    const svc = makeSvc();
    svc.singboxPid = 1234; // 运行中
    svc.currentConfig = cfg([ss('A')]);
    svc.customRuleFilesDegraded = true; // 外化文件写失败态：原会让 no-op 腿 degraded 桥自触发重启
    const planSpy = jest.spyOn(svc, 'planHotSwitch');
    const restartSpy = jest.spyOn(svc, 'scheduleDebouncedRestart').mockImplementation(() => {});
    const equalCfg = cfg([ss('A')]); // 内容全等、不同对象引用（模拟 C started-对账 loadConfig 出的等价 config）
    await svc.switchMode(equalCfg);
    expect(planSpy).not.toHaveBeenCalled(); // 短路在 planHotSwitch 之前
    expect(restartSpy).not.toHaveBeenCalled(); // degraded 桥未触发 → 无自触发重启循环（#1 修）
    expect(svc.currentConfig).toBe(equalCfg); // 引用更新
  });

  it('depth 仍 >0（嵌套 restart 内层 stop/start 收尾）→ 不 drain，留给最外层', async () => {
    const svc = makeSvc();
    const cfgB = cfg([ss('A'), ss('B')]);
    svc.pendingSwitchConfig = cfgB;
    svc.lifecycleDepth = 2; // restart 内嵌
    const spy = jest.spyOn(svc, 'switchMode').mockResolvedValue(undefined);
    svc.endLifecycleOp('start'); // depth 2→1，仍 >0 → 早返
    expect(svc.pendingSwitchConfig).toBe(cfgB); // 未消费（留给最外层）
    expect(spy).not.toHaveBeenCalled();
  });
});
