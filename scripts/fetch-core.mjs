#!/usr/bin/env node
/**
 * fetch-core.mjs — 按 core-manifest.json 的 bundledCoreVersion 从 SagerNet/sing-box 官方 release
 * 下载各平台 sing-box 二进制到 resources/{平台}/，供 electron-builder extraResources 随安装包打包
 * （与 libcronet/dashboard 同「现拉现打、不入库」模式）。
 *
 * 用法：node scripts/fetch-core.mjs [--force]
 *
 * 为什么改 fetch（原内置入库）：每平台核 66–74MB、4 平台 ~276MB 直接进 git，每次换核 git history 再叠
 * 一份 → 仓库与 clone 持续膨胀。改现拉现打后核不入库，仓库瘦身、克隆变快（与 libcronet/dashboard 一致）。
 *
 * 完整性 pin：core-manifest.json 的 coreArchiveSha256 是「下载的压缩包(tar.gz/zip)本体」的 sha256，其值
 * == 官方 release REST API 返回的 asset digest（gh api repos/SagerNet/sing-box/releases/tags/v<版本>
 * --jq '.assets[]|{name,digest}'，一行可取，换核直接抄、不必下载解压计算）。下载后对压缩包逐字节校验，不符
 * 即失败（fail-fast：损坏 / 截断 / 投毒在解压前就拦）。压缩包正确则解出的二进制必正确（tar/zip 解压确定性），
 * 故不必再对解压后二进制单独算 sha。
 *
 * 跨平台一致：全 4 平台核一律下载（不按当前 runner 过滤）——支持在 Linux 上 electron-builder --win/--mac
 * --dir 交叉构建（部署流程依赖）；skip-exists 已落地则跳过（换版本需 --force 或先删旧核；CI fresh checkout
 * 无旧核故每次都下载+校验）。解压：tar.gz→tar、zip→unzip（与 fetch-dashboard 同，CI 全平台已证可用）。各平台
 * 核仍是 SagerNet 官方 release（README §换核），cronet 集成因平台而异（mac-arm64 静态编入 / mac-x64 无 cronet
 * / linux+win dlopen 外部 libcronet 走 fetch:cronet），本脚本只取 sing-box 本体。
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 版本耦合的唯一真源：与 TS 主进程共享同一份 manifest，升级核心只需改 core-manifest.json。
const manifest = JSON.parse(readFileSync(join(ROOT, 'src/shared/core-manifest.json'), 'utf-8'));
const VERSION = manifest.bundledCoreVersion; // 资产名不带 v；release tag 带 v（如 v1.14.0-alpha.34）
const SHA = manifest.coreArchiveSha256 || {}; // 压缩包 sha == 官方 release API 的 asset digest
const REPO = 'SagerNet/sing-box';
const FORCE = process.argv.includes('--force');

// resources 目标目录 ← 官方资产名(压缩包) → 落地二进制名 → coreArchiveSha256 key。
// 官方资产解出单一顶层目录 sing-box-${VERSION}-${os}-${arch}/，内含 sing-box[.exe]（+ LICENSE；
// linux 资产另含 libcronet.so，本脚本只取 sing-box，cronet 仍由 fetch:cronet 按独立版本管理）。
const TARGETS = [
  { dir: 'resources/linux', asset: `sing-box-${VERSION}-linux-amd64.tar.gz`, bin: 'sing-box', key: 'linux' },
  { dir: 'resources/win', asset: `sing-box-${VERSION}-windows-amd64.zip`, bin: 'sing-box.exe', key: 'win' },
  { dir: 'resources/mac-x64', asset: `sing-box-${VERSION}-darwin-amd64.tar.gz`, bin: 'sing-box', key: 'mac-x64' },
  { dir: 'resources/mac-arm64', asset: `sing-box-${VERSION}-darwin-arm64.tar.gz`, bin: 'sing-box', key: 'mac-arm64' },
];

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

let ok = 0;
let failed = 0;
for (const t of TARGETS) {
  const absDir = join(ROOT, t.dir);
  const dest = join(absDir, t.bin);

  // 已落地则跳过（换版本需 --force 或先删旧核）。CI fresh checkout 无旧核 → 每次下载+校验。
  if (existsSync(dest) && !FORCE) {
    console.log(`skip (exists): ${t.dir}/${t.bin} — 若刚改 bundledCoreVersion(当前 ${VERSION})，须加 --force 重拉，否则沿用旧核`);
    ok++;
    continue;
  }

  // 完整性 pin 是供应链防护核心：缺 pin 直接 fail（绝不无校验拉可执行核），强制换版本时同步补 coreArchiveSha256。
  // normalize：容忍值带/不带 `sha256:` 前缀——官方 release REST API 的 asset digest 形如 `sha256:<hex>`，可原样抄进 manifest。
  const want = (SHA[t.key] || '').replace(/^sha256:/, '');
  if (!want) {
    console.error(
      `  FAILED ${t.key}: core-manifest.json 缺 coreArchiveSha256[${t.key}] pin → 拒绝无完整性校验拉取（换版本须同步补；值=官方 release API 的 asset digest）`
    );
    failed++;
    continue;
  }

  mkdirSync(absDir, { recursive: true });
  const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${t.asset}`;
  const work = mkdtempSync(join(tmpdir(), 'flowz-core-'));
  try {
    const archive = join(work, t.asset);
    console.log(`downloading ${t.asset} ...`);
    // -fL：失败返回非零（不把 404 页面当成功）+ 跟随重定向(release → objects.githubusercontent)；--retry 抗瞬时抖动。
    execFileSync('curl', ['-fL', '--retry', '3', '-o', archive, url], { stdio: 'inherit' });

    // 完整性校验：对下载的压缩包本体算 sha256，比对 manifest pin（= 官方 API asset digest）。fail-fast 于解压前。
    const got = sha256(archive);
    if (got !== want) {
      throw new Error(`压缩包 sha256 不符：期望 ${want}，实得 ${got}（版本漂移 / 投毒 / 截断）`);
    }

    const extractDir = join(work, 'x');
    mkdirSync(extractDir, { recursive: true });
    if (t.asset.endsWith('.zip')) {
      execFileSync('unzip', ['-q', '-o', archive, '-d', extractDir], { stdio: 'inherit' });
    } else {
      execFileSync('tar', ['xzf', archive, '-C', extractDir], { stdio: 'inherit' });
    }

    // 找含目标二进制的目录（官方为单一顶层目录；容错平铺）。
    let binPath = null;
    for (const n of readdirSync(extractDir)) {
      const cand = join(extractDir, n, t.bin);
      if (existsSync(cand)) {
        binPath = cand;
        break;
      }
    }
    if (!binPath && existsSync(join(extractDir, t.bin))) binPath = join(extractDir, t.bin);
    if (!binPath) throw new Error(`解压产物未找到 ${t.bin}（官方资产结构可能变化）`);

    // 原子落地：拷到 .tmp → chmod（unix 可执行）→ rename 顶替（避免半写文件被打包/误用）。
    const tmpDest = `${dest}.tmp`;
    rmSync(tmpDest, { force: true });
    copyFileSync(binPath, tmpDest);
    if (t.bin !== 'sing-box.exe') chmodSync(tmpDest, 0o755);
    renameSync(tmpDest, dest);
    console.log(`  ok: ${t.dir}/${t.bin} (archive sha ${got.slice(0, 12)}…)`);
    ok++;
  } catch (e) {
    console.error(`  FAILED ${t.key}: ${e.message}`);
    failed++;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

console.log(`\nsing-box cores: ${ok} ready, ${failed} failed (version ${VERSION}).`);
process.exit(failed > 0 ? 1 : 0);
