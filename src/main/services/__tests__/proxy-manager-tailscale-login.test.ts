/**
 * ProxyManager.startTailscaleLogin 瞬态登录核 STATUS 验真单测（根治 #132：toast 报已登录但角标恒需登录）。
 *
 * 覆盖：
 *  - 删 stateExists 短路后：纯 authKey 仍 alreadyLoggedIn / 无 key + 无 state 起瞬态核（spawn + 建 api client）。
 *  - 瞬态核 STATUS backendState=Running → emit EVENT_TAILSCALE_STATUS(loggedIn=true) + 主动杀核（killTailscaleLogin）。
 *  - 瞬态核 STATUS backendState=NeedsLogin + authURL → emit EVENT_TAILSCALE_STATUS(loggedIn=false, authURL) 且不杀核。
 *  - finalize（proc exit）清瞬态 api client 订阅（stop）+ 临时 cfg + Map 项。
 *
 * 全 mock、零网络：spawn 返回 fake ChildProcess；SingBoxApiClient mock 捕获 onUpdate 回调 + start/stop spy；
 * fs.existsSync→true、writeFileSync/unlinkSync no-op；mainWindow.webContents.send 捕获推渲染端事件。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');
const { EventEmitter } = require('events');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-tslogin-'));

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

// spawn → fake ChildProcess（stdout/stderr 为 EventEmitter，kill spy）；写盘相关 no-op，existsSync→true。
const spawnedProcs: any[] = [];
function makeFakeProc() {
  const proc: any = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  proc.pid = 4242;
  spawnedProcs.push(proc);
  return proc;
}
const mockSpawn = jest.fn((..._args: any[]) => makeFakeProc());
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args: any[]) => mockSpawn(...args),
}));

// SingBoxApiClient mock：捕获构造入参 + onUpdate 回调，start/stop 为 spy（验订阅 + finalize 清理）。
const apiClients: any[] = [];
jest.mock('../singbox-api-client', () => {
  class FakeSingBoxApiClient {
    endpoint: any;
    secret: string;
    onUpdate?: (eps: any[]) => void;
    start = jest.fn();
    stop = jest.fn();
    constructor(endpoint: any, secret: string, onUpdate?: (eps: any[]) => void) {
      this.endpoint = endpoint;
      this.secret = secret;
      this.onUpdate = onUpdate;
      apiClients.push(this);
    }
  }
  return { SingBoxApiClient: FakeSingBoxApiClient };
});

import { ProxyManager } from '../ProxyManager';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { ServerConfig } from '../../../shared/types';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  // fake timers：瞬态核 120s 超时 timer + SIGKILL 升级 timer 不留真 handle 卡住 jest 退出。
  jest.useFakeTimers();
  spawnedProcs.length = 0;
  apiClients.length = 0;
  mockSpawn.mockClear();
  jest.spyOn(fsSync, 'existsSync').mockReturnValue(true);
  jest.spyOn(fsSync, 'writeFileSync').mockImplementation(() => undefined as any);
  jest.spyOn(fsSync, 'unlinkSync').mockImplementation(() => undefined as any);
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function tsServer(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'srv-1',
    name: 'my-ts',
    protocol: 'tailscale',
    address: '',
    port: 0,
    tailscaleSettings: {},
    ...over,
  } as ServerConfig;
}

/** 构造 ProxyManager + fake mainWindow（webContents.send 捕获推渲染端事件）。 */
function makeSvc() {
  const sent: { channel: string; data: any }[] = [];
  const mainWindow: any = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, data: any) => sent.push({ channel, data }) },
  };
  const svc: any = new ProxyManager(
    { addLog: jest.fn() } as any,
    mainWindow,
    path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`),
    '/fake/sing-box'
  );
  return { svc, sent };
}

function tsStatusEvents(sent: { channel: string; data: any }[]) {
  return sent.filter((e) => e.channel === IPC_CHANNELS.EVENT_TAILSCALE_STATUS).map((e) => e.data);
}

describe('startTailscaleLogin：alreadyLoggedIn 短路（删 stateExists 后）', () => {
  it('纯 authKey → alreadyLoggedIn，不 spawn、不建 api client', async () => {
    const { svc } = makeSvc();
    const res = await svc.startTailscaleLogin(tsServer({ tailscaleSettings: { authKey: 'k' } }));
    expect(res).toEqual({ started: false, reason: 'alreadyLoggedIn' });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(apiClients).toHaveLength(0);
  });

  it('无 key + 无 state → 起瞬态核（spawn + 建独立 api client 并 start 订阅）', async () => {
    const { svc } = makeSvc();
    const res = await svc.startTailscaleLogin(tsServer());
    expect(res).toEqual({ started: true });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(apiClients).toHaveLength(1);
    // 独立 client：本地 127.0.0.1 + 随机 secret（非空）+ start() 已调（开 STATUS 订阅）。
    expect(apiClients[0].endpoint.host).toBe('127.0.0.1');
    expect(typeof apiClients[0].endpoint.port).toBe('number');
    expect(apiClients[0].endpoint.port).toBeGreaterThan(0);
    expect(apiClients[0].secret).toMatch(/^[0-9a-f]{32}$/); // 16 字节随机 hex
    expect(apiClients[0].start).toHaveBeenCalledTimes(1);
  });

  it('瞬态核 api 端口独立于主核 api 端口（避 bind 冲突）', async () => {
    const { svc } = makeSvc();
    svc.tailscaleApiPort = 9091; // 模拟主核已占该端口
    await svc.startTailscaleLogin(tsServer());
    expect(apiClients[0].endpoint.port).not.toBe(9091);
  });
});

describe('瞬态核 STATUS 验真', () => {
  it('backendState=Running → emit EVENT_TAILSCALE_STATUS(loggedIn=true) + 杀瞬态核', async () => {
    const { svc, sent } = makeSvc();
    await svc.startTailscaleLogin(tsServer({ id: 'srv-1', name: 'my-ts' }));
    const proc = spawnedProcs[0];
    // 驱动瞬态核 STATUS：Running（valid 既有 state 秒回，无浏览器）。
    apiClients[0].onUpdate([{ endpointTag: 'my-ts', backendState: 'Running', authURL: '' }]);

    const events = tsStatusEvents(sent);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ serverId: 'srv-1', backendState: 'Running', loggedIn: true });
    // 主动杀核：SIGTERM（escalateProcessKill 先发 SIGTERM）。
    expect(proc.kill).toHaveBeenCalled();
  });

  it('Running 但 key 已过期（self.expired）→ loggedIn=false（不误判已登录）', async () => {
    const { svc, sent } = makeSvc();
    await svc.startTailscaleLogin(tsServer({ id: 'srv-1', name: 'my-ts' }));
    apiClients[0].onUpdate([
      { endpointTag: 'my-ts', backendState: 'Running', authURL: '', self: { expired: true } },
    ]);
    const events = tsStatusEvents(sent);
    expect(events[0]).toMatchObject({ serverId: 'srv-1', loggedIn: false, expired: true });
  });

  it('backendState=NeedsLogin → emit loggedIn=false，不杀核；authURL 不经 STATUS 带（択一防双发，由 stdout 承载）', async () => {
    const { svc, sent } = makeSvc();
    await svc.startTailscaleLogin(tsServer({ id: 'srv-1', name: 'my-ts' }));
    const proc = spawnedProcs[0];
    apiClients[0].onUpdate([
      { endpointTag: 'my-ts', backendState: 'NeedsLogin', authURL: 'https://login.example/x' },
    ]);
    const events = tsStatusEvents(sent);
    expect(events[0]).toMatchObject({
      serverId: 'srv-1',
      backendState: 'NeedsLogin',
      loggedIn: false,
    });
    // 瞬态核 STATUS 不重复带 authURL（登录 URL 由 stdout AUTH_URL 单点承载 → handleTailscaleLoginUrl）。
    expect(events[0].authURL).toBeUndefined();
    expect(proc.kill).not.toHaveBeenCalled(); // 保活等用户浏览器授权
  });

  it('stdout AUTH_URL 行 → 推 EVENT_TAILSCALE_AUTH_URL（transient）并自动开浏览器（瞬态核 URL 单点来源）', async () => {
    const { svc, sent } = makeSvc();
    await svc.startTailscaleLogin(tsServer({ id: 'srv-1', name: 'my-ts' }));
    const proc = spawnedProcs[0];
    proc.stdout.emit(
      'data',
      Buffer.from(
        'endpoint/tailscale[my-ts]: Waiting for authentication: https://login.example/abc\n'
      )
    );
    const authEvents = sent.filter((e) => e.channel === IPC_CHANNELS.EVENT_TAILSCALE_AUTH_URL);
    expect(authEvents).toHaveLength(1);
    expect(authEvents[0].data).toMatchObject({
      serverId: 'srv-1',
      transient: true,
      url: 'https://login.example/abc',
    });
  });

  it('STATUS 中无本节点 endpoint（tag 不匹配）→ 不 emit、不杀核', async () => {
    const { svc, sent } = makeSvc();
    await svc.startTailscaleLogin(tsServer({ id: 'srv-1', name: 'my-ts' }));
    const proc = spawnedProcs[0];
    apiClients[0].onUpdate([{ endpointTag: 'other-node', backendState: 'Running', authURL: '' }]);
    expect(tsStatusEvents(sent)).toHaveLength(0);
    expect(proc.kill).not.toHaveBeenCalled();
  });
});

describe('finalize 清理（proc exit）', () => {
  it('proc exit → stop 瞬态 api client + 删 Map 项（可再次 startTailscaleLogin）', async () => {
    const { svc } = makeSvc();
    await svc.startTailscaleLogin(tsServer());
    const proc = spawnedProcs[0];
    const client = apiClients[0];
    expect(svc.tailscaleLoginCores.has('srv-1')).toBe(true);

    proc.emit('exit', 0, null); // 进程退出 → finalize

    expect(client.stop).toHaveBeenCalledTimes(1); // 停订阅 + 关连接（防泄漏）
    expect(svc.tailscaleLoginCores.has('srv-1')).toBe(false); // Map 项已清 → 不卡 alreadyRunning

    // 清干净后可再起一次（不再返回 alreadyRunning）。
    const res2 = await svc.startTailscaleLogin(tsServer());
    expect(res2).toEqual({ started: true });
  });

  it('spawn error（只 emit error 无 exit）→ 也 finalize（stop client + 删 Map，防泄漏）', async () => {
    const { svc } = makeSvc();
    await svc.startTailscaleLogin(tsServer());
    const proc = spawnedProcs[0];
    const client = apiClients[0];

    proc.emit('error', new Error('ENOENT'));

    expect(client.stop).toHaveBeenCalledTimes(1);
    expect(svc.tailscaleLoginCores.has('srv-1')).toBe(false);
  });
});

// #174 review MED-5：空 authUrl（清「登录中」）下沉 finalize，覆盖取消/崩溃/超时全退出路径；成功路径不发（避免 clobber）。
describe('finalize 发空 authUrl 清「登录中」（取消/崩溃 → 清；成功 → 不清）', () => {
  /** 过滤 finalize 收尾发的空 authUrl（serverId + url:''，无 transient/nodeName）。 */
  function emptyAuthUrlEvents(sent: { channel: string; data: any }[], serverId: string) {
    return sent.filter(
      (e) =>
        e.channel === IPC_CHANNELS.EVENT_TAILSCALE_AUTH_URL &&
        e.data?.serverId === serverId &&
        e.data?.url === ''
    );
  }

  it('用户取消（cancelTailscaleLogin → proc exit）→ 发空 authUrl 退出「登录中」', async () => {
    const { svc, sent } = makeSvc();
    await svc.startTailscaleLogin(tsServer({ id: 'srv-1', name: 'my-ts' }));
    const proc = spawnedProcs[0];

    svc.cancelTailscaleLogin('srv-1'); // 用户手动取消 → killTailscaleLogin → SIGTERM
    proc.emit('exit', 0, null); // 进程退出 → finalize

    expect(emptyAuthUrlEvents(sent, 'srv-1')).toHaveLength(1);
  });

  it('核自行崩溃（无取消，直接 proc exit）→ 发空 authUrl 退出「登录中」', async () => {
    const { svc, sent } = makeSvc();
    await svc.startTailscaleLogin(tsServer({ id: 'srv-1', name: 'my-ts' }));
    const proc = spawnedProcs[0];

    proc.emit('exit', 1, null); // 核崩溃退出 → finalize

    expect(emptyAuthUrlEvents(sent, 'srv-1')).toHaveLength(1);
  });

  it('spawn error → 发空 authUrl（同退出路径）', async () => {
    const { svc, sent } = makeSvc();
    await svc.startTailscaleLogin(tsServer({ id: 'srv-1', name: 'my-ts' }));
    const proc = spawnedProcs[0];

    proc.emit('error', new Error('ENOENT')); // 只 emit error → finalize

    expect(emptyAuthUrlEvents(sent, 'srv-1')).toHaveLength(1);
  });

  it('登录成功（STATUS=Running → 杀核 → proc exit）→ finalize 不发空 authUrl（不 clobber 成功态）', async () => {
    const { svc, sent } = makeSvc();
    await svc.startTailscaleLogin(tsServer({ id: 'srv-1', name: 'my-ts' }));
    const proc = spawnedProcs[0];

    // Running → 标记 loginCompleted + 杀核
    apiClients[0].onUpdate([{ endpointTag: 'my-ts', backendState: 'Running', authURL: '' }]);
    proc.emit('exit', 0, null); // 被杀退出 → finalize

    expect(emptyAuthUrlEvents(sent, 'srv-1')).toHaveLength(0);
  });
});
