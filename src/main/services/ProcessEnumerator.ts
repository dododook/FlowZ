/**
 * 跨平台系统进程枚举：供「路由规则 → 进程快速选择器」从运行中的进程挑选 process_name 规则。
 * 三平台均不需提权（仅 Linux 读他人进程 exe 可能 EACCES，降级为 cmdline argv[0]）。
 * 输出按可执行名聚合去重，返回 { name, path?, count }，按 name 排序，过滤空名与自身 sing-box。
 */
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { SystemProcessInfo } from '../../shared/types';
import { system32, powershellPath } from '../utils/win-system32';

const EXEC_TIMEOUT_MS = 5000;

function execFileP(
  cmd: string,
  args: string[],
  opts: {
    timeout: number;
    maxBuffer: number;
    windowsHide?: boolean;
    env?: NodeJS.ProcessEnv;
  }
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, encoding: 'utf-8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** 把 (name, path) 列表聚合为去重的 SystemProcessInfo[]（按 name 大小写不敏感聚合，保留首个 path）。 */
function aggregate(
  items: Array<{ name: string; path?: string }>,
  caseInsensitive: boolean
): SystemProcessInfo[] {
  const map = new Map<string, SystemProcessInfo>();
  for (const it of items) {
    const name = (it.name || '').trim();
    if (!name) continue;
    if (name === 'sing-box' || name === 'sing-box.exe') continue; // 过滤自身核心
    const key = caseInsensitive ? name.toLowerCase() : name;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      if (!existing.path && it.path) existing.path = it.path;
    } else {
      map.set(key, { name, path: it.path, count: 1 });
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );
}

async function listMac(): Promise<SystemProcessInfo[]> {
  // ps comm 即完整可执行路径；basename 为进程名。
  // macOS 从 Finder/LaunchServices 启动的 GUI 应用可能继承 C locale；此时 ps 会把 UTF-8
  // 路径的每个非 ASCII 字节先转义成 `M-fM-...`，Node 之后再按 UTF-8 解码也无法恢复。
  // 必须在启动 ps 时就强制 UTF-8 locale；LC_ALL 覆盖母进程残留的 LC_CTYPE=C，
  // LANG 作为不识别 LC_ALL 时的同值兜底。en_US.UTF-8 是 macOS 系统内置 locale。
  const out = await execFileP('/bin/ps', ['-axo', 'comm='], {
    timeout: EXEC_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    },
  });
  const items = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((p) => ({ name: path.basename(p), path: p.startsWith('/') ? p : undefined }));
  return aggregate(items, false);
}

async function listLinux(): Promise<SystemProcessInfo[]> {
  const items: Array<{ name: string; path?: string }> = [];
  let pids: string[];
  try {
    pids = (await fs.readdir('/proc')).filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
  await Promise.all(
    pids.map(async (pid) => {
      try {
        // 过滤内核线程：cmdline 为空
        const cmdline = await fs.readFile(`/proc/${pid}/cmdline`, 'utf-8').catch(() => '');
        if (!cmdline.replace(/\0/g, '').trim()) return;

        let exePath: string | undefined;
        try {
          // 已删除/已更新的二进制 readlink 返回 "<path> (deleted)" → 去掉后缀，防污染选择器
          exePath = (await fs.readlink(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, '');
        } catch {
          // 他人进程 exe EACCES → 用 cmdline argv[0]
          const argv0 = cmdline.split('\0')[0];
          if (argv0 && argv0.startsWith('/')) exePath = argv0;
        }

        let name = '';
        if (exePath) name = path.basename(exePath);
        if (!name) {
          // 退而读 comm（进程名，可能被截断到 15 字符）
          const comm = await fs.readFile(`/proc/${pid}/comm`, 'utf-8').catch(() => '');
          name = comm.trim();
        }
        if (name) items.push({ name, path: exePath });
      } catch {
        /* 进程已退出/无权限，跳过 */
      }
    })
  );
  return aggregate(items, false);
}

async function listWindows(): Promise<SystemProcessInfo[]> {
  // 进程名：tasklist（最稳、无需管理员）
  let names: string[] = [];
  try {
    const out = await execFileP(system32('tasklist.exe'), ['/fo', 'csv', '/nh'], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    names = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        // CSV: "name.exe","pid",...
        const m = l.match(/^"([^"]+)"/);
        return m ? m[1] : '';
      })
      .filter(Boolean);
  } catch {
    return [];
  }

  // 路径增强（可选，失败降级仅名）：PowerShell Get-CimInstance（wmic 已弃用）
  const pathByName = new Map<string, string>();
  try {
    const ps = await execFileP(
      powershellPath(),
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object Name,ExecutablePath | ConvertTo-Json -Compress',
      ],
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
    );
    const parsed = JSON.parse(ps) as
      | Array<{ Name?: string; ExecutablePath?: string }>
      | {
          Name?: string;
          ExecutablePath?: string;
        };
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    for (const p of arr) {
      if (p?.Name && p.ExecutablePath && !pathByName.has(p.Name.toLowerCase())) {
        pathByName.set(p.Name.toLowerCase(), p.ExecutablePath);
      }
    }
  } catch {
    /* 路径增强失败 → 仅返回名 */
  }

  const items = names.map((name) => ({ name, path: pathByName.get(name.toLowerCase()) }));
  return aggregate(items, true);
}

/** 枚举当前系统进程（聚合去重）。失败返回空数组（UI 显示空态）。 */
export async function listSystemProcesses(): Promise<SystemProcessInfo[]> {
  try {
    if (process.platform === 'darwin') return await listMac();
    if (process.platform === 'linux') return await listLinux();
    if (process.platform === 'win32') return await listWindows();
  } catch {
    /* 静默 */
  }
  return [];
}
