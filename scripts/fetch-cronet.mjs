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
 * ⚠️ **取源＝Go module proxy，不是 GitHub Releases**（2026-08-05 改）：sing-box 自身经 Go module
 *   `github.com/sagernet/cronet-go/lib/<平台>` 拿预编译库，而 SagerNet/cronet-go 的 Releases 已停更
 *   （最新仍是 v148，而 sing-box 1.14.0-beta.5 已用到 naiveproxy 150）。继续走 Releases 会让打包库与核
 *   永久漂移，故改为与核**同源**取模块 zip。
 *
 * ⚠️ **MODULE_BASE 与 pin 绑定，禁止换 GOPROXY 镜像**：module zip 的字节由构造者的 golang.org/x/mod/zip
 *   版本与压缩参数决定（zip 内的 1980 时间戳只保证时间字段确定，不保证压缩流逐字节一致），goproxy.cn /
 *   自建 Athens 可能重新打包 → sha 不符。换镜像必须按下方流程用该镜像重取 pin，不可沿用本文件的值。
 *
 * ⚠️ **换核必须同步换本脚本的版本**：cronetVersion 就是从「随包 sing-box 的 go.mod」抄来的，两者绑定。
 *   脚本在**每次实际下载前**会自动校验二者一致（取 sing-box 的 .mod 比对），不一致直接 fail —— 这条自动
 *   校验是本设计的防漂移主闸，注释只是它的说明书。
 *
 * ── 换版本操作（三步）────────────────────────────────────────────────────────
 *  1) 取 cronet-go/lib 伪版本（与随包核同源，免鉴权，无需 gh）：
 *       curl -fsSL "https://proxy.golang.org/github.com/sagernet/sing-box/@v/v<bundledCoreVersion>.mod" \
 *         | grep 'cronet-go/lib/linux_amd64'
 *  2) 取两类 sha256 pin。**推荐走 Go 工具链**，使其经 sum.golang.org 透明日志背书（append-only Merkle
 *     log + 第三方审计者），强于直接 curl 同一个 URL 自算（后者是纯 TOFU，只防传输损坏与事后篡改）：
 *       d=$(mktemp -d); cd $d && go mod init tmp >/dev/null
 *       GOMODCACHE=$d/gomod go get github.com/sagernet/cronet-go/lib/linux_amd64@<伪版本>
 *       sha256sum $d/gomod/cache/download/github.com/sagernet/cronet-go/lib/linux_amd64/@v/<伪版本>.zip
 *     （仓库已依赖 Go——helper 用它编译——故零新增依赖。注：`.ziphash` 不是 proxy 协议端点，
 *      实测 GET 返回 404 `unexpected extension "ziphash"`，别走那条路。）
 *  3) 把 zip sha 填进 cronetArchiveSha256，跑 `npm run fetch:cronet -- --force`；脚本会打印落地库本体的
 *     sha256，填进 cronetLibSha256 即可。
 *
 * ── 两类 pin 的分工（都不可删）────────────────────────────────────────────────
 *  · cronetArchiveSha256 —— 下载的 module zip 本体 sha256。防传输损坏/截断/投毒，落位前 fail-fast。
 *  · cronetLibSha256     —— **解出并落地的库本体** sha256。两个作用：①锁定「zip 里解出来的到底是哪个
 *    文件」；②让 **skip 分支可自证** —— 磁盘上已存在的库能当场重算比对，不匹配即 fail 并要求 --force。
 *    缺了它，「换 manifest 版本但忘加 --force」会静默沿用旧库打进安装包，且构建链与运行期全程无声
 *    （核有 reconcileCoreWithBundledBaseline 兜底，libcronet 没有任何版本层面的运行期对照）。
 *  libcronet 是运行期 dlopen 加载执行的原生库，故与 sing-box 核同级供应链防护：缺任一 pin 直接拒拉。
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 版本耦合的唯一真源：与 TS 主进程共享同一份 manifest，升级核心只需改 core-manifest.json。
const coreManifest = JSON.parse(
  readFileSync(join(ROOT, 'src/shared/core-manifest.json'), 'utf-8')
);
// cronet-go/lib/<平台> 的 Go module 伪版本，抄自随包 sing-box 版本的 go.mod（见文件头取法）。
const CRONET_VERSION = coreManifest.cronetVersion;
const CORE_VERSION = coreManifest.bundledCoreVersion;
const CRONET_SHA = coreManifest.cronetArchiveSha256 || {}; // module zip 本体 sha256
const CRONET_LIB_SHA = coreManifest.cronetLibSha256 || {}; // 落地库本体 sha256（skip 分支自证用）
const PROXY = 'https://proxy.golang.org';
const MODULE_BASE = `${PROXY}/github.com/sagernet/cronet-go/lib`;
const FORCE = process.argv.includes('--force');
// 新增外部 host（Google 网段，可达性与 github.com 不同）→ 显式超时，避免无代理环境下静默卡死数分钟。
const CURL_TIMEOUTS = ['--connect-timeout', '15', '--max-time', '600'];

// 仅 linux/windows 走动态库；mac 静态编入核心二进制，不需下载（见文件头）。
// resources 目标目录 ← cronet-go lib 模块名 → 模块内库文件名(== 落地名，purego 期望) → sha pin key。
// 注：两平台共用一个 cronetVersion —— 这是「上游同 commit 一次性打包全部 lib 子模块」的结果，不是协议
// 保证；真分叉时本脚本会 404 或 sha 不符 → fail-closed，不会静默出错。
const TARGETS = [
  { dir: 'resources/linux', mod: 'linux_amd64', lib: 'libcronet.so', key: 'linux' },
  { dir: 'resources/win', mod: 'windows_amd64', lib: 'libcronet.dll', key: 'win' },
];

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const normSha = (v) => (v || '').replace(/^sha256:/, '');

/**
 * 防漂移主闸：cronetVersion 必须等于「随包 sing-box 版本的 go.mod 所引 cronet-go/lib/<平台> 版本」。
 * 只在真要下载时调用一次（skip 全通过的离线重建不触网）。取不到 .mod 即 fail-closed —— 无法证明同源时
 * 不放行，与「缺 pin 拒拉」同一立场。
 */
function assertCronetMatchesCore(mods) {
  const url = `${PROXY}/github.com/sagernet/sing-box/@v/v${CORE_VERSION}.mod`;
  const out = execFileSync('curl', ['-fsSL', ...CURL_TIMEOUTS, url], { encoding: 'utf-8' });
  for (const mod of mods) {
    const m = out.match(new RegExp(`cronet-go/lib/${mod}\\s+(\\S+)`));
    if (!m) {
      throw new Error(`sing-box ${CORE_VERSION} 的 go.mod 未引用 cronet-go/lib/${mod}（上游结构变化？）`);
    }
    if (m[1] !== CRONET_VERSION) {
      throw new Error(
        `cronetVersion 与随包内核不同源：core ${CORE_VERSION} 要 ${m[1]}，manifest 写的是 ${CRONET_VERSION}` +
          `（换核后须同步更新 cronetVersion + 两类 sha，见脚本头「换版本操作」）`
      );
    }
  }
}

let ok = 0;
let failed = 0;
const pending = [];

// 第一遍：能自证的 skip 掉，其余进 pending（决定是否需要触网校验同源）。
for (const t of TARGETS) {
  const dest = join(ROOT, t.dir, t.lib);
  const wantLib = normSha(CRONET_LIB_SHA[t.key]);
  if (!FORCE && existsSync(dest)) {
    if (!wantLib) {
      console.error(
        `  FAILED ${t.key}: 磁盘已有 ${t.lib} 但 core-manifest.json 缺 cronetLibSha256[${t.key}] → 无法自证其版本，拒绝沿用（补 pin 或加 --force 重拉）`
      );
      failed++;
      continue;
    }
    const got = sha256(dest);
    if (got === wantLib) {
      console.log(`skip (verified): ${t.dir}/${t.lib} (lib sha ${got.slice(0, 12)}…)`);
      ok++;
      continue;
    }
    console.log(
      `stale: ${t.dir}/${t.lib} 与 cronetLibSha256 不符（磁盘 ${got.slice(0, 12)}… ≠ 期望 ${wantLib.slice(0, 12)}…）→ 重新下载`
    );
  }
  pending.push(t);
}

if (pending.length > 0) {
  try {
    assertCronetMatchesCore(pending.map((t) => t.mod));
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    console.log(`\ncronet libs: ${ok} ready, ${pending.length} failed (module ${CRONET_VERSION}).`);
    process.exit(1);
  }
}

for (const t of pending) {
  const absDir = join(ROOT, t.dir);
  const dest = join(absDir, t.lib);
  // 完整性 pin 是供应链防护核心：缺 pin 直接 fail（绝不无校验拉可 dlopen 的原生库）。
  const want = normSha(CRONET_SHA[t.key]);
  if (!want) {
    console.error(
      `  FAILED ${t.key}: core-manifest.json 缺 cronetArchiveSha256[${t.key}] pin → 拒绝无完整性校验拉取（值=module zip 的 sha256，见脚本头「换版本操作」）`
    );
    failed++;
    continue;
  }
  mkdirSync(absDir, { recursive: true });
  const url = `${MODULE_BASE}/${t.mod}/@v/${CRONET_VERSION}.zip`;
  const work = mkdtempSync(join(tmpdir(), 'flowz-cronet-'));
  const tmpDest = `${dest}.tmp`;
  try {
    const archive = join(work, `${t.mod}.zip`);
    console.log(`downloading ${t.mod} module → ${t.dir}/${t.lib} ...`);
    // -fL：失败返回非零（不把错误页当成功）+ 跟随重定向；--retry 抗瞬时抖动。与 fetch-core 同款。
    execFileSync('curl', ['-fL', '--retry', '3', ...CURL_TIMEOUTS, '-o', archive, url], {
      stdio: 'inherit',
    });

    // 完整性校验①：对下载的 module zip 本体算 sha256，比对 manifest pin。fail-fast 于解压前。
    const got = sha256(archive);
    if (got !== want) {
      throw new Error(`module zip sha256 不符：期望 ${want}，实得 ${got}（版本漂移 / 投毒 / 截断）`);
    }

    // 只解目标文件并拍平路径（-j）：module zip 内为 `<module path>@<version>/` 多层前缀，`-j` 后直接落
    // extractDir/<lib>。无匹配时 unzip 退 11 → execFileSync 抛 → 下方 catch 接住，仍 fail-closed。
    // 同时避免顺带解出同目录 57MB 的 libcronet.a（本脚本不需要）。
    const extractDir = join(work, 'x');
    mkdirSync(extractDir, { recursive: true });
    execFileSync('unzip', ['-q', '-o', '-j', archive, `*/${t.lib}`, '-d', extractDir], {
      stdio: 'inherit',
    });
    const libPath = join(extractDir, t.lib);
    if (!existsSync(libPath)) throw new Error(`解压产物未找到 ${t.lib}（上游模块结构可能变化）`);

    // 完整性校验②：库本体 sha —— 锁定「解出来的到底是哪个文件」，并为后续 skip 分支留下可自证的锚。
    const libGot = sha256(libPath);
    const wantLib = normSha(CRONET_LIB_SHA[t.key]);
    if (wantLib && libGot !== wantLib) {
      throw new Error(`库本体 sha256 不符：期望 ${wantLib}，实得 ${libGot}`);
    }

    // 原子落地：拷到 .tmp → chmod（unix 可执行）→ rename 顶替（避免半写文件被打包/误用）。
    rmSync(tmpDest, { force: true });
    copyFileSync(libPath, tmpDest);
    if (t.lib.endsWith('.so')) chmodSync(tmpDest, 0o755);
    renameSync(tmpDest, dest);
    console.log(`  ok: ${t.dir}/${t.lib} (zip sha ${got.slice(0, 12)}…, lib sha ${libGot})`);
    if (!wantLib) {
      console.log(
        `  ⚠ core-manifest.json 缺 cronetLibSha256[${t.key}] → 请填入上面的 lib sha（否则下次 skip 无法自证）`
      );
    }
    ok++;
  } catch (e) {
    console.error(`  FAILED ${t.key}: ${e.message}`);
    failed++;
  } finally {
    // 清理顺序无关紧要，但 .tmp 必须在这里清：copyFileSync 成功而 chmod/rename 失败时（磁盘满 / 杀软锁
    // 文件），残留的 .tmp 会被 electron-builder 的 `**/*` filter 打进安装包。
    rmSync(tmpDest, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

console.log(`\ncronet libs: ${ok} ready, ${failed} failed (module ${CRONET_VERSION}).`);
console.log('macOS: cronet 静态编入 mac-arm64 核心，无需下载（见脚本头注）。');
process.exit(failed > 0 ? 1 : 0);
