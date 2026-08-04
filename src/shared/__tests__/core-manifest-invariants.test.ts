/**
 * core-manifest.json 不变量门 —— 挂在 `npm run test:core-gate` 上（**打包链必经**：package:* / dist:* /
 * release:prepare 都跑它），而不是只挂全量 `npm test`。理由：本门要拦的事故是「换核时 manifest 改错/漏改
 * → 打进安装包」，只有站在打包链上才拦得住。
 *
 * 被保护的对象是 `scripts/fetch-cronet.mjs` 与 `scripts/fetch-core.mjs`（cronetVersion 在主进程无任何
 * 消费方，全仓仅这两个脚本 + 本测试读它），故断言放在 shared 侧、不寄生于某个 runtime 单测。
 */
import * as manifest from '../core-manifest.json';

const HEX64 = /^[0-9a-f]{64}$/;

describe('core-manifest：版本字段', () => {
  it('bundledCoreVersion 非空', () => {
    expect(typeof (manifest as { bundledCoreVersion?: string }).bundledCoreVersion).toBe('string');
    expect((manifest as { bundledCoreVersion?: string }).bundledCoreVersion).toBeTruthy();
  });

  /**
   * cronet 取源不变量：libcronet 改经 **Go module proxy** 取（与随包 sing-box 的 go.mod 同源），
   * SagerNet/cronet-go 的 **Releases 已停更**（停在 v148，而核已用到 naiveproxy 150）。
   *
   * 若有人把 release tag（chromium 式，形如 `v148.0.7778.96-1`）粘回 cronetVersion：fetch-cronet 会 404，
   * 而磁盘上已存在的库**在旧实现里会被静默沿用** → naive 与核永久漂移且零报错。现已由脚本的 cronetLibSha256
   * 自证 + 同源校验双重拦截，本断言是第三道（最早、最便宜的一道）。
   *
   * 形状判据刻意**不锁基版本段**：当前上游从未给 lib 子模块打 tag（`@v/list` 实测为空），故伪版本恒为
   * `v0.0.0-<14位时间戳>-<12位hash>`；一旦上游打了 tag，Go 生成的伪版本会变成 `v<next>-0.<ts>-<hash>`，
   * 那是**完全合法**的值，不该让门在此误红（误红时最省事的「修法」是把正则放宽成 `.*`，门就没了）。
   */
  it('cronetVersion 是 Go module 伪版本，不是 chromium 式 release tag', () => {
    const v = (manifest as { cronetVersion?: string }).cronetVersion || '';
    // 必含伪版本后缀：14 位 UTC 时间戳 + 12 位 commit 前缀
    expect(v).toMatch(/-\d{14}-[0-9a-f]{12}$/);
    // 反面：chromium 式主版本号（v148.x / v150.x）说明取源退回了 Releases
    expect(v).not.toMatch(/^v\d{3,}\./);
  });
});

describe('core-manifest：供应链 pin 齐全（缺 pin 时 fetch 脚本拒拉，此处提前暴露）', () => {
  it('coreArchiveSha256 覆盖四平台且为 64 位 hex', () => {
    const m = (manifest as { coreArchiveSha256?: Record<string, string> }).coreArchiveSha256 || {};
    for (const key of ['linux', 'win', 'mac-x64', 'mac-arm64']) {
      expect(m[key]).toMatch(HEX64);
    }
  });

  /**
   * cronet 两类 pin 分工（都不可删，见 fetch-cronet.mjs 头注）：
   *   · cronetArchiveSha256 = 下载的 module zip 本体 → 防传输损坏/投毒，落位前 fail-fast
   *   · cronetLibSha256     = 解出并落地的库本体 → ①锁定「解出来的是哪个文件」②让 skip 分支可自证
   * 仅 linux/win 走动态库；mac 的 cronet 静态编入核心二进制，故此处只断言两平台。
   */
  it('cronet 两类 sha 覆盖 linux/win 且为 64 位 hex', () => {
    const zip =
      (manifest as { cronetArchiveSha256?: Record<string, string> }).cronetArchiveSha256 || {};
    const lib = (manifest as { cronetLibSha256?: Record<string, string> }).cronetLibSha256 || {};
    for (const key of ['linux', 'win']) {
      expect(zip[key]).toMatch(HEX64);
      expect(lib[key]).toMatch(HEX64);
    }
  });

  it('zip sha 与 lib sha 不相等（防把同一个值误填两处）', () => {
    const zip =
      (manifest as { cronetArchiveSha256?: Record<string, string> }).cronetArchiveSha256 || {};
    const lib = (manifest as { cronetLibSha256?: Record<string, string> }).cronetLibSha256 || {};
    for (const key of ['linux', 'win']) {
      expect(zip[key]).not.toBe(lib[key]);
    }
  });
});
