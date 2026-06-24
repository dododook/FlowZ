import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { reconcileTreeOwnership } from '../runtime-ownership';

describe('reconcileTreeOwnership — 运行时目录属主归一', () => {
  let tmp: string;
  const uid = process.getuid ? process.getuid() : 0;
  const gid = process.getgid ? process.getgid() : 0;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-own-'));
  });
  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('目录不存在 → no-op 空结果', () => {
    const r = reconcileTreeOwnership(path.join(tmp, 'nope'), uid, gid);
    expect(r).toEqual({ chowned: [], deleted: [], failed: [] });
  });

  it('全部已属登录用户 → 不动（无 chown / 删除，文件保留）', () => {
    fs.mkdirSync(path.join(tmp, 'sub'));
    fs.writeFileSync(path.join(tmp, 'sub', 'a.txt'), 'x');
    fs.writeFileSync(path.join(tmp, 'b.txt'), 'y');
    const r = reconcileTreeOwnership(tmp, uid, gid);
    expect(r.chowned).toEqual([]);
    expect(r.deleted).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'sub', 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'b.txt'))).toBe(true);
  });

  it('属主非 target（模拟 root 残留）→ chown 或删除让创建者重建', () => {
    // 文件实为当前 uid；target 设 uid+1 触发「非 target」分支。
    // 非 root 环境：chown(→uid+1) EPERM → unlink(父目录可写) → deleted；root 环境：chown 成功 → chowned。
    fs.writeFileSync(path.join(tmp, 'tailscaled.log.conf'), 'stale-root-600');
    const r = reconcileTreeOwnership(tmp, uid + 1, gid);
    expect(r.chowned.length + r.deleted.length).toBe(1);
    expect(r.failed).toEqual([]);
    if (r.deleted.length === 1) {
      // 删除路径：残留被清，交 tsnet 以登录用户重建
      expect(fs.existsSync(path.join(tmp, 'tailscaled.log.conf'))).toBe(false);
    }
  });

  it('嵌套：登录用户拥有的子目录内含「非 target」文件 → 递归进入处理，子目录本身保留', () => {
    // 镜像真机结构：tailscale/<id>/(登录用户) 下含 root 文件
    const idDir = path.join(tmp, '802f-id');
    fs.mkdirSync(idDir);
    fs.writeFileSync(path.join(idDir, 'tailscaled.state'), 's');
    const r = reconcileTreeOwnership(tmp, uid + 1, gid);
    // 子目录(uid)与其内文件(uid)对 target=uid+1 都「非 target」→ 都被处理；至少内层文件被处理一次
    expect(r.chowned.length + r.deleted.length).toBeGreaterThanOrEqual(1);
    expect(r.failed).toEqual([]);
  });
});
