#!/usr/bin/env node
/**
 * fetch-dashboard.mjs — 拉取 sing-box 官方面板（SagerNet/sing-box-dashboard 的 gh-pages 构建产物）到
 * resources/dashboard/，供 electron-builder 的 extraResources 随安装包打包（dashboard #55）。
 *
 * 用法：node scripts/fetch-dashboard.mjs [--force]
 *
 * 为什么随包内置：面板原走 sing-box `services[].dashboard.enabled` 首次**联网下载**，慢启动 + 离线不可用。改随包后
 * 核以 `dashboard:{enabled,path:<bundledDir>}` 直接 serve 本地文件（实证 1.14-alpha.32 日志：「serving user-provided
 * files, auto-update disabled」，/dashboard/ HTTP 200，零联网）。运行时「刷新面板资源」下载新版覆盖至 <userData>/dashboard
 * （serve 优先用覆盖版、否则回落内置），与内置 geo 规则集「下载优先、内置兜底」语义一致。
 *
 * 机制：下载 gh-pages 分支 zipball（含构建好的静态资源）→ 解压 → 把含 index.html 的目录平铺到 resources/dashboard/。
 * 拉取走 curl（CI/打包环境就绪）；解压走 unzip。原子落地：先解到临时目录、校验 index.html 存在再 rename 替换。
 */
import { execFileSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'resources', 'dashboard');
const FORCE = process.argv.includes('--force');

// gh-pages 分支 zipball（GitHub codeload）：含构建好的面板静态资源（index.html + assets）。
const ZIP_URL = 'https://github.com/SagerNet/sing-box-dashboard/archive/refs/heads/gh-pages.zip';

if (existsSync(join(DEST, 'index.html')) && !FORCE) {
  console.log(`skip (exists): resources/dashboard/index.html`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'flowz-dashboard-'));
const zipPath = join(work, 'dashboard.zip');
const extractDir = join(work, 'extracted');

try {
  console.log(`downloading sing-box-dashboard (gh-pages) → ${zipPath} ...`);
  // -L 跟随重定向；-f 失败返回非零（不把 404 页面当成功）；--retry 抗瞬时网络抖动。
  execFileSync('curl', ['-fL', '--retry', '3', '-o', zipPath, ZIP_URL], { stdio: 'inherit' });

  mkdirSync(extractDir, { recursive: true });
  console.log('extracting ...');
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', extractDir], { stdio: 'inherit' });

  // zipball 解出单一顶层目录（如 sing-box-dashboard-gh-pages/）；找含 index.html 的目录作为面板根。
  const top = readdirSync(extractDir).map((n) => join(extractDir, n));
  let uiRoot = top.find((p) => existsSync(join(p, 'index.html')));
  if (!uiRoot && existsSync(join(extractDir, 'index.html'))) uiRoot = extractDir;
  if (!uiRoot) {
    throw new Error('解压产物中未找到 index.html（gh-pages 结构可能变化）');
  }

  // 原子替换：先拷到 DEST.tmp 再 rename 顶替，避免半写目录被打包/serve。
  // dereference:true —— 万一压缩包含符号链接，落实体文件而非把 symlink 原样打进 resources（纵深防御）。
  const tmpDest = `${DEST}.tmp`;
  rmSync(tmpDest, { recursive: true, force: true });
  mkdirSync(dirname(DEST), { recursive: true });
  cpSync(uiRoot, tmpDest, { recursive: true, dereference: true });
  rmSync(DEST, { recursive: true, force: true });
  renameSync(tmpDest, DEST);

  console.log(`ok: resources/dashboard/ ready (index.html present).`);
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
