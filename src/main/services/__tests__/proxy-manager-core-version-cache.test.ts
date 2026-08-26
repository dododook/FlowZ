/**
 * B5：`getCoreVersion(force)` 的二进制指纹缓存单测。
 *
 * 背景：启动路径每次 start 都 `force=true` 重 spawn 一次 45MB 内核（Windows 上还要过 AV 扫描）。force 的本意是
 * 「核可能换了，别信旧缓存」——那就直接问二进制换没换，而不是无条件重探。
 *
 * 要钉住的四条（错一条就是「换了核还报旧版本」或「缓存白加」）：
 *  1. 同一文件 + force → 不重 spawn；
 *  2. 文件变了（mtime/size/路径）→ 必重 spawn；
 *  3. 探测失败不写指纹（下次仍重探）；
 *  4. `getCoreVersionLine(true)` **不**吃这条缓存——它是换核后「诚实重读活二进制」的验证腿（issue #150）。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-b5ver-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ProxyManager } from '../ProxyManager';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 造一个真实存在的假核文件（指纹要靠 statSync 取真值）。 */
function makeCoreFile(content = 'core-v1'): string {
  const p = path.join(TMP, `sing-box-${Math.random().toString(36).slice(2)}`);
  fsSync.writeFileSync(p, content);
  return p;
}

function makeSvc(corePath: string): {
  svc: any;
  spawns: () => number;
  setLine: (l: string) => void;
} {
  const configPath = path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`);
  const svc: any = new ProxyManager(undefined, undefined, configPath, corePath);
  let line = 'sing-box version 1.14.0';
  let n = 0;
  // 桩掉真实 spawn（execve 一个假文件必失败），只数调用次数。
  svc.doSpawnCoreVersionFirstLine = async () => {
    n++;
    return line;
  };
  return { svc, spawns: () => n, setLine: (l: string) => (line = l) };
}

describe('B5 — getCoreVersion(force) 指纹缓存', () => {
  it('同一二进制未变 → force 也不重 spawn', async () => {
    const { svc, spawns } = makeSvc(makeCoreFile());

    await expect(svc.getCoreVersion(true)).resolves.toBe('1.14.0');
    expect(spawns()).toBe(1);

    await expect(svc.getCoreVersion(true)).resolves.toBe('1.14.0');
    await expect(svc.getCoreVersion(true)).resolves.toBe('1.14.0');
    expect(spawns()).toBe(1); // 变异守卫：删掉指纹分支这里会变成 3
  });

  it('二进制被换掉（内容+mtime 变）→ 重 spawn 并拿到新版本', async () => {
    const corePath = makeCoreFile();
    const { svc, spawns, setLine } = makeSvc(corePath);

    await expect(svc.getCoreVersion(true)).resolves.toBe('1.14.0');
    expect(spawns()).toBe(1);

    // 模拟 CoreUpdateService 换核：内容变长 + mtime 前移一小时（size / mtime 任一变即失配）
    fsSync.writeFileSync(corePath, 'core-v2-longer-content');
    const future = new Date(Date.now() + 3600_000);
    fsSync.utimesSync(corePath, future, future);
    setLine('sing-box version 1.15.0');

    await expect(svc.getCoreVersion(true)).resolves.toBe('1.15.0');
    expect(spawns()).toBe(2);
  });

  it('现役核路径改指（同会话换核/换目录）→ 指纹含路径，必重 spawn', async () => {
    const { svc, spawns, setLine } = makeSvc(makeCoreFile());
    await svc.getCoreVersion(true);
    expect(spawns()).toBe(1);

    svc.singboxPath = makeCoreFile('another'); // 另一个文件
    setLine('sing-box version 1.16.0');
    await expect(svc.getCoreVersion(true)).resolves.toBe('1.16.0');
    expect(spawns()).toBe(2);
  });

  it('二进制不存在（stat 失败）→ 指纹取不到，每次都重探（回落改动前行为）', async () => {
    const { svc, spawns } = makeSvc(path.join(TMP, 'does-not-exist'));

    await svc.getCoreVersion(true);
    await svc.getCoreVersion(true);
    expect(spawns()).toBe(2);
  });

  it('探测失败不写指纹：下一次仍重探（不把失败缓存成结论）', async () => {
    const corePath = makeCoreFile();
    const { svc } = makeSvc(corePath);
    let n = 0;
    svc.doSpawnCoreVersionFirstLine = async () => {
      n++;
      if (n === 1) throw new Error('spawn 炸了');
      return 'sing-box version 1.14.0';
    };

    await svc.getCoreVersion(true); // 失败 → 回落随包基线，不写指纹
    await expect(svc.getCoreVersion(true)).resolves.toBe('1.14.0');
    expect(n).toBe(2);
  });

  it('换核后探测失败 → 不得把旧版本连同新指纹一起缓存（否则新核永远报旧版本）', async () => {
    const corePath = makeCoreFile();
    const { svc } = makeSvc(corePath);
    let n = 0;
    svc.doSpawnCoreVersionFirstLine = async () => {
      n++;
      if (n === 1) return 'sing-box version 1.14.0'; // 旧核探测成功
      if (n === 2) throw new Error('新核刚写完，execve 撞上了'); // 换核后首探失败
      return 'sing-box version 1.15.0'; // 重探成功
    };

    await expect(svc.getCoreVersion(true)).resolves.toBe('1.14.0');

    fsSync.writeFileSync(corePath, 'core-v2-longer-content');
    const future = new Date(Date.now() + 3600_000);
    fsSync.utimesSync(corePath, future, future);
    await svc.getCoreVersion(true); // 失败：绝不能把新指纹配旧版本写进缓存

    // 变异守卫：若失败路径也写指纹，这里会命中缓存直接返回陈旧的 1.14.0
    await expect(svc.getCoreVersion(true)).resolves.toBe('1.15.0');
    expect(n).toBe(3);
  });

  it('非 force 的老缓存路径不受影响（有缓存即返回，零 spawn）', async () => {
    const { svc, spawns } = makeSvc(makeCoreFile());
    await svc.getCoreVersion(true);
    expect(spawns()).toBe(1);

    await expect(svc.getCoreVersion()).resolves.toBe('1.14.0');
    expect(spawns()).toBe(1);
  });

  it('getCoreVersionLine(true) 不吃指纹缓存——换核后的诚实重读腿必须真的重读', async () => {
    const { svc, spawns } = makeSvc(makeCoreFile());
    await svc.getCoreVersion(true);
    expect(spawns()).toBe(1);

    await svc.getCoreVersionLine(true);
    await svc.getCoreVersionLine(true);
    expect(spawns()).toBe(3); // 每次都真去问二进制
  });
});

/**
 * 指纹三分量的**隔离**用例。原有夹具同时改内容长度和 mtime、换文件时 mtime 又天然不同，无法隔离任一分量——
 * 复审实测：把 path 从指纹里删掉、把 mtimeMs 删掉、甚至只剩 mtimeMs，原套件全绿（M8a/M8b/M8c）。
 * 覆盖面继承自夹具而不是从判据（path ∨ size ∨ mtime 任一变即失配）生成，故按判据逐分量补齐。
 */
describe('B5 — 指纹三分量各自都必须参与失配', () => {
  it('只改 mtime（path 与 size 均不变）→ 必重 spawn', async () => {
    const corePath = makeCoreFile('same-length');
    const { svc, spawns, setLine } = makeSvc(corePath);
    await expect(svc.getCoreVersion(true)).resolves.toBe('1.14.0');
    expect(spawns()).toBe(1);

    // 等长覆写 → size 不变；再显式把 mtime 推到未来 → 只有 mtime 变了
    fsSync.writeFileSync(corePath, 'SAME-LENGTH');
    const t = new Date(Date.now() + 7200_000);
    fsSync.utimesSync(corePath, t, t);
    setLine('sing-box version 1.15.0');

    // 变异守卫：指纹丢掉 mtimeMs → 命中缓存 → 仍返 1.14.0 → 红
    await expect(svc.getCoreVersion(true)).resolves.toBe('1.15.0');
    expect(spawns()).toBe(2);
  });

  it('只改 size（path 与 mtime 均不变）→ 必重 spawn', async () => {
    const corePath = makeCoreFile('short');
    // 先把 mtime 归整到整毫秒再取基准：`utimesSync` 只有毫秒精度，直接拿 statSync 的带小数 mtime 去复原
    // 会把小数截掉 ⇒ mtime 其实变了 ⇒ 这条用例就不再是「只改 size」（首版即栽在这里）。
    const FIXED = new Date(Date.now() - 60_000);
    fsSync.utimesSync(corePath, FIXED, FIXED);

    const { svc, spawns, setLine } = makeSvc(corePath);
    await svc.getCoreVersion(true);
    const before = fsSync.statSync(corePath);
    expect(spawns()).toBe(1);

    fsSync.writeFileSync(corePath, 'a-much-longer-content');
    fsSync.utimesSync(corePath, FIXED, FIXED); // 同一个时刻 → mtime 逐位复原，只有 size 变了
    expect(fsSync.statSync(corePath).mtimeMs).toBe(before.mtimeMs);
    expect(fsSync.statSync(corePath).size).not.toBe(before.size);
    setLine('sing-box version 1.15.0');

    // 变异守卫：指纹丢掉 size → 命中缓存 → 红
    await expect(svc.getCoreVersion(true)).resolves.toBe('1.15.0');
    expect(spawns()).toBe(2);
  });

  it('只改 path（size 与 mtime 均不变）→ 必重 spawn', async () => {
    const FIXED = new Date(Date.now() - 60_000); // 同上：先归整到整毫秒，两个文件才对得齐
    const first = makeCoreFile('identical');
    fsSync.utimesSync(first, FIXED, FIXED);

    const { svc, spawns, setLine } = makeSvc(first);
    await svc.getCoreVersion(true);
    const st = fsSync.statSync(first);
    expect(spawns()).toBe(1);

    const second = makeCoreFile('identical'); // 同长度
    fsSync.utimesSync(second, FIXED, FIXED); // 同一时刻 → size 与 mtime 都相同，只有 path 不同
    expect(fsSync.statSync(second).size).toBe(st.size);
    expect(fsSync.statSync(second).mtimeMs).toBe(st.mtimeMs);
    svc.singboxPath = second;
    setLine('sing-box version 1.15.0');

    // 变异守卫：指纹丢掉 path → 命中缓存 → 红（这正是「同会话换核到另一目录」的形态）
    await expect(svc.getCoreVersion(true)).resolves.toBe('1.15.0');
    expect(spawns()).toBe(2);
  });
});
