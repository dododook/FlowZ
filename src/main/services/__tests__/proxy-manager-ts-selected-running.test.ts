/**
 * ProxyManager：选中账号制（Tailscale）节点的「隧道就绪即 emit」去重 + 会话起点重置单测。
 *
 * 背景（修 review Med）：handleTailscaleStatus 用 lastTsSelectedRunningId 对「选中 TS 节点翻 Running」做上升沿去重
 * （STATUS 持续推帧不每帧触发）；运行期掉线/切节点由「本帧非 Running → 清标记」兜。但 stop() 断 tailscaleApiClient
 * 后不再有 STATUS 帧来清此标记，残留的 Running 标记会让重连同一节点时新 STATUS 首帧 Running 被去重命中、
 * 'tailscale-selected-running' 不发射 → 事件驱动出口 re-probe 丢失。修：startInternal 起点显式重置该字段。
 *
 * 全 mock、零网络、零进程：仅直接驱动 private handleTailscaleStatus（推 STATUS 帧）+ 验字段/事件，
 * 并验 startInternal 起点重置点（spy maybePromptHelperGate reject 截停于任何 spawn/写盘之前）。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-ts-selrun-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {
    static isSupported() {
      return false;
    }
  },
  shell: { openExternal: jest.fn(() => Promise.resolve()) },
  net: {},
  session: {},
}));

// ResourceManager mock：startInternal 早段（重置行之后、截停点之前）在 Linux 会调 ensureWritableCore 准备可写核 —— mock
// 成安全 no-op，杜绝任何真核拷贝/文件系统副作用（本测仅验字段重置点，不跑真 spawn/写盘/版本探测）。
jest.mock('../ResourceManager', () => ({
  resourceManager: {
    ensureWritableCore: jest.fn(async () => '/fake/sing-box'),
    getSingBoxPath: jest.fn(() => '/fake/sing-box'),
  },
}));

import { ProxyManager } from '../ProxyManager';
import type { ServerConfig, UserConfig } from '../../../shared/types';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function tsServer(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'srv-ts',
    name: 'my-ts',
    protocol: 'tailscale',
    address: '',
    port: 0,
    tailscaleSettings: {},
    ...over,
  } as ServerConfig;
}

/** 构造 ProxyManager + fake mainWindow（webContents.send no-op，仅吸收 emitTailscaleStatus）。 */
function makeSvc() {
  const mainWindow: any = {
    isDestroyed: () => false,
    webContents: { send: jest.fn() },
  };
  const svc: any = new ProxyManager(
    { addLog: jest.fn() } as any,
    mainWindow,
    path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`),
    '/fake/sing-box'
  );
  return { svc };
}

/** currentConfig：选中一个 TS 节点为全局出口。 */
function configWithSelectedTs(): UserConfig {
  return {
    selectedServerId: 'srv-ts',
    servers: [tsServer()],
  } as unknown as UserConfig;
}

const RUNNING = [{ endpointTag: 'my-ts', backendState: 'Running', authURL: '' }];
const STARTING = [{ endpointTag: 'my-ts', backendState: 'Starting', authURL: '' }];

describe('选中 TS 节点 Running 上升沿 → emit tailscale-selected-running（去重）', () => {
  it('首帧 Running → emit + 置 lastTsSelectedRunningId；持续 Running 帧不重复 emit', () => {
    const { svc } = makeSvc();
    svc.currentConfig = configWithSelectedTs();
    const emitted = jest.fn();
    svc.on('tailscale-selected-running', emitted);

    svc.handleTailscaleStatus(RUNNING);
    expect(emitted).toHaveBeenCalledTimes(1);
    expect(svc.lastTsSelectedRunningId).toBe('srv-ts');

    // 同节点持续推 Running（STATUS 流每秒推帧）→ 去重命中，不再 emit。
    svc.handleTailscaleStatus(RUNNING);
    svc.handleTailscaleStatus(RUNNING);
    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it('Starting / 非 Running 不触发；运行期翻 Running 才上升沿 emit', () => {
    const { svc } = makeSvc();
    svc.currentConfig = configWithSelectedTs();
    const emitted = jest.fn();
    svc.on('tailscale-selected-running', emitted);

    svc.handleTailscaleStatus(STARTING);
    expect(emitted).not.toHaveBeenCalled();
    expect(svc.lastTsSelectedRunningId).toBeNull();

    svc.handleTailscaleStatus(RUNNING);
    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it('运行期掉线（本帧非 Running）→ 清标记，重新 Running 能再 emit（覆盖运行期重连）', () => {
    const { svc } = makeSvc();
    svc.currentConfig = configWithSelectedTs();
    const emitted = jest.fn();
    svc.on('tailscale-selected-running', emitted);

    svc.handleTailscaleStatus(RUNNING);
    expect(emitted).toHaveBeenCalledTimes(1);

    // 掉线一帧（非 Running）→ STATUS 流自身清标记。
    svc.handleTailscaleStatus(STARTING);
    expect(svc.lastTsSelectedRunningId).toBeNull();

    svc.handleTailscaleStatus(RUNNING);
    expect(emitted).toHaveBeenCalledTimes(2);
  });
});

describe('会话起点重置 lastTsSelectedRunningId（修 stop 后重连同节点丢事件）', () => {
  it('stop 后残留 Running 标记，下次会话起点（startInternal）归零 → 重连同节点能再次 emit', async () => {
    const { svc } = makeSvc();
    svc.currentConfig = configWithSelectedTs();
    const emitted = jest.fn();
    svc.on('tailscale-selected-running', emitted);

    // 会话 1：选中 TS 节点翻 Running → emit。
    svc.handleTailscaleStatus(RUNNING);
    expect(emitted).toHaveBeenCalledTimes(1);
    expect(svc.lastTsSelectedRunningId).toBe('srv-ts');

    // 模拟 stop()：断 tailscaleApiClient（不再有 STATUS 帧来清标记），末状态 Running 标记残留。
    // stop() 在无进程时早退、不清此字段 —— 故标记一直残留到下次会话。
    await svc.stop();
    expect(svc.lastTsSelectedRunningId).toBe('srv-ts'); // 残留确认（stop 本身不重置）

    // 会话 2：startInternal 起点重置该字段。spy maybePromptHelperGate reject 截停于任何 spawn/写盘/版本探测之前
    // （重置行在 startInternal 极早处、先于这些重活），既验重置点又不触碰真核/网络。
    jest.spyOn(svc, 'maybePromptHelperGate').mockRejectedValue(new Error('test-cut-before-spawn'));
    await expect(svc.startInternal(configWithSelectedTs(), { interactive: true })).rejects.toThrow(
      'test-cut-before-spawn'
    );
    expect(svc.lastTsSelectedRunningId).toBeNull(); // 会话起点已归零

    // 会话 2 的新 STATUS 首帧 Running → 标记已干净 → 能再次 emit（修复前会被残留标记去重吞掉）。
    svc.currentConfig = configWithSelectedTs();
    svc.handleTailscaleStatus(RUNNING);
    expect(emitted).toHaveBeenCalledTimes(2);
  });
});
