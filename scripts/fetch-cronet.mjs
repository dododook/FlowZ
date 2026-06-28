#!/usr/bin/env node
/**
 * fetch-cronet.mjs — 下载各平台 NaiveProxy 核心库 libcronet 到 resources/{平台}/，
 * 供 electron-builder 的 extraResources(`**​/*` filter) 随安装包打包（与 sing-box 二进制同模式）。
 *
 * 用法：node scripts/fetch-cronet.mjs [--force]
 *
 * ⚠️ macOS 不在此脚本范围：cronet 在 mac 上不走动态库。FlowZ 的 mac-arm64 sing-box 二进制已把 cronet
 *   静态编入（CGO，实测二进制内含 cronet 符号、无 dlopen libcronet.dylib），naive 开箱即用、无需任何
 *   外部库。mac-x64 二进制未编入 cronet → naive 暂不可用（需重编带 naive 的 x64 核心）。详见 README。
 *
 * ⚠️ 版本耦合：cronetVersion（src/shared/core-manifest.json）应与「随 app 打包的 sing-box 所用
 *   cronet-go 版本」对应。cronet 走 C API（Chromium 稳定 ABI），跨 sing-box 小版本一般兼容；若升级
 *   sing-box 后 naive 报符号错，提高 manifest 中的版本并重打包。该 manifest 同时被 TS 主进程读取，
 *   是核心/cronet 版本耦合的唯一真源。来源：https://github.com/SagerNet/cronet-go/releases
 *
 * 完整性 pin（与 fetch-core 对称）：core-manifest.json 的 cronetArchiveSha256 是「下载的 libcronet 库本体」
 *   的 sha256，其值 == cronet-go release REST API 返回的 asset digest（gh api
 *   repos/SagerNet/cronet-go/releases/tags/<cronetVersion> --jq '.assets[]|{name,digest}'，一行可取，
 *   换版本直接抄）。libcronet 是运行期 dlopen 加载执行的原生库，故与 sing-box 核同级别供应链防护：下载后
 *   逐字节校验、不符即 fail（落位前拦损坏/截断/投毒），缺 pin 直接拒拉（绝不无校验拉可执行原生库）。
 */
import { createHash } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'fs';
import { get } from 'https';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 版本耦合的唯一真源：与 TS 主进程共享同一份 manifest，升级核心只需改 core-manifest.json。
const coreManifest = JSON.parse(
  readFileSync(join(ROOT, 'src/shared/core-manifest.json'), 'utf-8')
);
const CRONET_VERSION = coreManifest.cronetVersion; // ← 与打包 sing-box 的 cronet-go 版本对齐
const CRONET_SHA = coreManifest.cronetArchiveSha256 || {}; // 库本体 sha == cronet-go release API 的 asset digest
const REPO = 'SagerNet/cronet-go';
const FORCE = process.argv.includes('--force');

// 仅 linux/windows 走动态库；mac 静态编入核心二进制，不需下载（见文件头）。
// resources 目标目录 ← cronet-go 资产名 → 落地文件名(purego 期望) → cronetArchiveSha256 key。
const TARGETS = [
  { dir: 'resources/linux', asset: 'libcronet-linux-amd64.so', out: 'libcronet.so', key: 'linux' },
  { dir: 'resources/win', asset: 'libcronet-windows-amd64.dll', out: 'libcronet.dll', key: 'win' },
];

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function download(url, dest, want, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    get(url, { headers: { 'User-Agent': 'FlowZ-fetch-cronet' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, want, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      // 原子写：先写 .tmp，完成再 rename；失败/中断则删 .tmp，避免把截断文件当成"已存在"误用
      const tmp = `${dest}.tmp`;
      const file = createWriteStream(tmp);
      const fail = (e) => {
        try {
          unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        reject(e);
      };
      res.on('error', fail);
      file.on('error', fail);
      res.pipe(file);
      file.on('finish', () =>
        file.close((err) => {
          if (err) return fail(err);
          // 完整性校验：对下载库本体算 sha256，比对 manifest pin（= cronet-go release API 的 asset digest）。
          // fail-fast 于落位前——损坏/截断/投毒不会 rename 到 dest（坏 .tmp 由 fail() 清理）。
          try {
            const got = sha256(tmp);
            if (got !== want) {
              return fail(
                new Error(`sha256 不符：期望 ${want}，实得 ${got}（版本漂移 / 投毒 / 截断）`)
              );
            }
            renameSync(tmp, dest);
            resolve();
          } catch (e) {
            fail(e);
          }
        })
      );
    }).on('error', reject);
  });
}

let ok = 0;
let failed = 0;
for (const t of TARGETS) {
  const absDir = join(ROOT, t.dir);
  const dest = join(absDir, t.out);
  if (existsSync(dest) && !FORCE) {
    console.log(`skip (exists): ${t.dir}/${t.out}`);
    ok++;
    continue;
  }
  // 完整性 pin 是供应链防护核心：缺 pin 直接 fail（绝不无校验拉可 dlopen 的原生库）；换版本须同步补 cronetArchiveSha256。
  // normalize：容忍带/不带 `sha256:` 前缀——cronet-go release API 的 asset digest 形如 `sha256:<hex>`，可原样抄进 manifest。
  const want = (CRONET_SHA[t.key] || '').replace(/^sha256:/, '');
  if (!want) {
    console.error(
      `  FAILED ${t.key}: core-manifest.json 缺 cronetArchiveSha256[${t.key}] pin → 拒绝无完整性校验拉取（换版本须同步补；值=cronet-go release API 的 asset digest）`
    );
    failed++;
    continue;
  }
  mkdirSync(absDir, { recursive: true });
  const url = `https://github.com/${REPO}/releases/download/${CRONET_VERSION}/${t.asset}`;
  try {
    console.log(`downloading ${t.asset} → ${t.dir}/${t.out} ...`);
    await download(url, dest, want);
    console.log(`  ok (sha ${want.slice(0, 12)}…)`);
    ok++;
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    failed++;
  }
}
console.log(`\ncronet libs: ${ok} ready, ${failed} failed (version ${CRONET_VERSION}).`);
console.log('macOS: cronet 静态编入 mac-arm64 核心，无需下载（见脚本头注）。');
process.exit(failed > 0 ? 1 : 0);
