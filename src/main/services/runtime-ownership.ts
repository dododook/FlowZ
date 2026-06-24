/**
 * 运行时目录属主归一(根治跨提权态属主冲突)。
 *
 * 背景:macOS/Windows 下 TUN 模式经提权(root/SYSTEM)跑 sing-box,tsnet 把 tailscale state 写成 root 600;
 * 切系统代理(登录用户)再跑时,sing-box 以登录用户运行,open 不了 root 600 的 state 文件 → FATAL
 * `permission denied`,且 endpoint post-start 失败会拖垮整个启动(即便没选 tailscale 节点)。
 * Linux 用 setcap(始终登录用户跑)天然免疫。
 *
 * 主进程恒以登录用户运行:能 chown 自己拥有的文件(no-op),且对**登录用户可写的父目录**(如 `tailscale/<id>/`)
 * 能删除其中的 root 残留文件 → 让 tsnet 以登录用户重建。本模块即此「启动前归一」的纯逻辑,绝不抛、尽力而为。
 *
 * 仅 POSIX(darwin/linux);Windows 属主模型不同(SYSTEM/ACL),由 helper 侧 takeown 覆盖(后续)。
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ReconcileResult {
  /** 成功 chown 回 targetUid 的路径(主进程拥有写权限的少数情况)。 */
  chowned: string[];
  /** chown 无权(他人 root 文件)后删除的路径(父目录可写时成功),交创建者重建为登录用户。 */
  deleted: string[];
  /** 既 chown 不了又删不掉的路径(父目录不可写,如 root 拥有的目录内部)+ 原因。 */
  failed: { path: string; error: string }[];
}

/**
 * 递归归一 `root` 目录树下所有条目的属主到 (targetUid/targetGid):
 * - 已是 targetUid → 跳过(不动)
 * - 非 targetUid → 先 chown;无权(EPERM)则在父目录可写时 unlink/rmdir,让属主进程重建为登录用户
 * 先递归子目录(无论子目录属主),再处理目录本身,保证「先清空再删目录」。
 */
export function reconcileTreeOwnership(
  root: string,
  targetUid: number,
  targetGid: number
): ReconcileResult {
  const res: ReconcileResult = { chowned: [], deleted: [], failed: [] };
  // 只归一 root 的**子项**（递归），绝不删除/动 root 自身——它是调用方给定的边界目录（如 `tailscale/`），
  // 删掉整棵就把所有节点的 state 清光了。root 不存在/读不了 → no-op。
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return res;
  }
  for (const name of entries) {
    walk(path.join(root, name), targetUid, targetGid, res);
  }
  return res;
}

function walk(p: string, uid: number, gid: number, res: ReconcileResult): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return; // 不存在 → no-op
  }

  // 目录:先递归处理子项(无论本目录属主——如 `tailscale/<id>/` 本身是登录用户、但内部文件是 root)
  if (st.isDirectory()) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(p);
    } catch (e) {
      // 读不了(如 root 拥有且无 o+r 的目录)→ 记失败,不阻断
      res.failed.push({ path: p, error: errMsg(e) });
    }
    for (const name of entries) {
      walk(path.join(p, name), uid, gid, res);
    }
  }

  if (st.uid === uid) return; // 本项已归属登录用户 → 不动

  // 本项属主非登录用户:先试 chown(主进程多半无权改他人 root 文件 → 进 catch)
  try {
    fs.chownSync(p, uid, gid);
    res.chowned.push(p);
    return;
  } catch {
    /* 无权 chown → 尝试删除让创建者重建 */
  }
  try {
    if (st.isDirectory()) fs.rmdirSync(p);
    else fs.unlinkSync(p);
    res.deleted.push(p);
  } catch (e) {
    res.failed.push({ path: p, error: errMsg(e) });
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
