import { findSuitableSingboxAsset, normalizeAssetDigest } from '../singbox-asset';

const asset = (name: string) => ({ name, browser_download_url: `https://x/${name}` });

describe('findSuitableSingboxAsset', () => {
  it('linux x64 → 匹配 linux+amd64+.tar.gz', () => {
    const a = findSuitableSingboxAsset(
      [
        asset('sing-box-1.13.0-darwin-arm64.tar.gz'),
        asset('sing-box-1.13.0-linux-amd64.tar.gz'),
        asset('sing-box-1.13.0-windows-amd64.zip'),
      ],
      'linux',
      'x64'
    );
    expect(a.name).toBe('sing-box-1.13.0-linux-amd64.tar.gz');
  });

  it('darwin arm64 → 匹配 darwin+arm64', () => {
    const a = findSuitableSingboxAsset(
      [asset('sing-box-1.13.0-darwin-amd64.tar.gz'), asset('sing-box-1.13.0-darwin-arm64.tar.gz')],
      'darwin',
      'arm64'
    );
    expect(a.name).toBe('sing-box-1.13.0-darwin-arm64.tar.gz');
  });

  it('优先含 with-naive / full 的构建', () => {
    const a = findSuitableSingboxAsset(
      [
        asset('sing-box-1.13.0-windows-amd64.zip'),
        asset('sing-box-1.13.0-windows-amd64-with-naive.zip'),
      ],
      'win32',
      'x64'
    );
    expect(a.name).toBe('sing-box-1.13.0-windows-amd64-with-naive.zip');
  });

  it('with-naive 缺失时排除 legacy 取非 legacy', () => {
    const a = findSuitableSingboxAsset(
      [
        asset('sing-box-1.13.0-linux-amd64-legacy.tar.gz'),
        asset('sing-box-1.13.0-linux-amd64.tar.gz'),
      ],
      'linux',
      'x64'
    );
    expect(a.name).toBe('sing-box-1.13.0-linux-amd64.tar.gz');
  });

  it('全为 legacy 时回落首个匹配', () => {
    const a = findSuitableSingboxAsset(
      [asset('sing-box-1.13.0-linux-amd64-legacy.tar.gz')],
      'linux',
      'x64'
    );
    expect(a.name).toBe('sing-box-1.13.0-linux-amd64-legacy.tar.gz');
  });

  it('Windows 接受 .zip 后缀', () => {
    const a = findSuitableSingboxAsset(
      [asset('sing-box-1.13.0-windows-amd64.zip')],
      'win32',
      'x64'
    );
    expect(a.name).toBe('sing-box-1.13.0-windows-amd64.zip');
  });

  it('无平台/架构匹配 → undefined', () => {
    const a = findSuitableSingboxAsset(
      [asset('sing-box-1.13.0-linux-amd64.tar.gz')],
      'darwin',
      'arm64'
    );
    expect(a).toBeUndefined();
  });

  it('空 assets → undefined', () => {
    expect(findSuitableSingboxAsset([], 'linux', 'x64')).toBeUndefined();
  });
});

describe('normalizeAssetDigest — 运行期换核的完整性锚', () => {
  const HEX = 'a'.repeat(64);

  it('sha256:<64hex> → 小写裸 hex', () => {
    expect(normalizeAssetDigest({ digest: `sha256:${HEX}` })).toBe(HEX);
    expect(normalizeAssetDigest({ digest: `sha256:${'A'.repeat(64)}` })).toBe(HEX);
    expect(normalizeAssetDigest({ digest: `  sha256:${HEX}  ` })).toBe(HEX);
  });

  /**
   * 形状不符一律 null、**绝不兜底放行**：调用方据 null 拒装。若在此放宽（比如「没有前缀就当 hex 用」），
   * 「拿不到摘要」会静默退化成「不校验」，而运行期换核会回落 gh-proxy 第三方镜像——那正是要防的场景。
   */
  it('缺失 / 非 sha256 / 长度或字符不对 / 非字符串 → null', () => {
    const bad: unknown[] = [
      undefined,
      null,
      {},
      { digest: null },
      { digest: 123 },
      { digest: HEX }, // 裸 hex 无算法前缀：不认
      { digest: `md5:${'a'.repeat(32)}` },
      { digest: `sha256:${'a'.repeat(63)}` },
      { digest: `sha256:${'g'.repeat(64)}` },
      { digest: `sha512:${'a'.repeat(128)}` },
    ];
    for (const a of bad) expect(normalizeAssetDigest(a)).toBeNull();
  });
});
