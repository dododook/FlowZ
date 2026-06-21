/**
 * #60：App 自更新下载兜底镜像应用用户 ghProxyPrefix（与内核/资源下载同一加速前缀）。
 *
 * 修复前：UpdateService 无 configProvider，downloadWithHardening 的兜底镜像调 ghMirrorUrl(url) 不传前缀
 *   → 国内用户即便配了 gh 加速也只会回落内置 preset[0]，自更新拉不到 GitHub。
 * 本测覆盖逻辑增量 resolveGhPrefix：configProvider 注入的 config.ghProxyPrefix 经 normalizeGhProxyPrefix
 *   规范化后产出前缀；未注入 / 空 / 非法 / 读失败 → undefined（直连兜底，不抛）。
 * ghMirrorUrl(url, prefix) 拼接行为已由 shared/__tests__/gh-proxy.test.ts 覆盖，此处不重复。
 */
import * as os from 'os';
import * as path from 'path';
import * as fsSync from 'fs';

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-upd-gh-'));

jest.mock('electron', () => ({
  app: {
    getPath: () => TMP,
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => TMP,
  },
  shell: {},
  BrowserWindow: class {},
  dialog: {},
  net: {},
}));

import { UpdateService } from '../UpdateService';

const log = { addLog: () => {} } as any;

// private resolveGhPrefix 是 #60 的逻辑增量，经 as any 直访（无网络、纯逻辑）。
const resolve = (svc: UpdateService): Promise<string | undefined> =>
  (svc as unknown as { resolveGhPrefix: () => Promise<string | undefined> }).resolveGhPrefix();

describe('UpdateService #60 resolveGhPrefix', () => {
  it('未注入 configProvider → undefined（旧行为，直连兜底）', async () => {
    const svc = new UpdateService(log);
    expect(await resolve(svc)).toBeUndefined();
  });

  it('config.ghProxyPrefix 裸域名 → 规范化为 https://host/', async () => {
    const svc = new UpdateService(log);
    svc.setConfigProvider(async () => ({ ghProxyPrefix: 'my.mirror.com' }) as any);
    expect(await resolve(svc)).toBe('https://my.mirror.com/');
  });

  it('config.ghProxyPrefix 完整 https URL → 原样规范化（去尾部多余斜杠/补尾斜杠）', async () => {
    const svc = new UpdateService(log);
    svc.setConfigProvider(async () => ({ ghProxyPrefix: 'https://gh.example.org' }) as any);
    expect(await resolve(svc)).toBe('https://gh.example.org/');
  });

  it('空 ghProxyPrefix → undefined', async () => {
    const svc = new UpdateService(log);
    svc.setConfigProvider(async () => ({ ghProxyPrefix: '' }) as any);
    expect(await resolve(svc)).toBeUndefined();
  });

  it('非法 ghProxyPrefix（非 https / 带路径）→ undefined（normalizeGhProxyPrefix 拒）', async () => {
    const svc = new UpdateService(log);
    svc.setConfigProvider(async () => ({ ghProxyPrefix: 'http://x/path' }) as any);
    expect(await resolve(svc)).toBeUndefined();
  });

  it('configProvider 抛错 → undefined（失败安全，不冒泡）', async () => {
    const svc = new UpdateService(log);
    svc.setConfigProvider(async () => {
      throw new Error('config read failed');
    });
    expect(await resolve(svc)).toBeUndefined();
  });

  it('configProvider 返回 null → undefined', async () => {
    const svc = new UpdateService(log);
    svc.setConfigProvider(async () => null);
    expect(await resolve(svc)).toBeUndefined();
  });
});
