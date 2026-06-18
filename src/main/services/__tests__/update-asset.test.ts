/**
 * findSuitableUpdateAsset 纯逻辑（#72）：Windows setup/portable 按运行形态消歧 + 跨平台不串台。
 */
import { findSuitableUpdateAsset } from '../update-asset';

const A = (name: string) => ({ name, browser_download_url: `https://x/${name}` });

// v4.0.4 真实 release 全量资产（混平台，验选择不串台）。
const RELEASE = [
  A('FlowZ-4.0.4-linux-amd64.deb'),
  A('FlowZ-4.0.4-linux-x86_64.AppImage'),
  A('FlowZ-4.0.4-mac-arm64.dmg'),
  A('FlowZ-4.0.4-win-x64-portable.exe'),
  A('FlowZ-4.0.4-win-x64-setup.exe'),
];

describe('findSuitableUpdateAsset — Windows setup/portable 消歧 (#72)', () => {
  it('便携态 → 取 portable.exe（而非 setup）', () => {
    const a = findSuitableUpdateAsset(RELEASE, 'win32', 'x64', true);
    expect(a?.name).toBe('FlowZ-4.0.4-win-x64-portable.exe');
  });

  it('安装态(NSIS) → 取 setup.exe（而非 portable）', () => {
    const a = findSuitableUpdateAsset(RELEASE, 'win32', 'x64', false);
    expect(a?.name).toBe('FlowZ-4.0.4-win-x64-setup.exe');
  });

  it('选择与资产数组顺序无关（setup 在前也不误选）', () => {
    const reordered = [A('FlowZ-4.0.4-win-x64-setup.exe'), A('FlowZ-4.0.4-win-x64-portable.exe')];
    expect(findSuitableUpdateAsset(reordered, 'win32', 'x64', true)?.name).toBe(
      'FlowZ-4.0.4-win-x64-portable.exe'
    );
    expect(findSuitableUpdateAsset(reordered, 'win32', 'x64', false)?.name).toBe(
      'FlowZ-4.0.4-win-x64-setup.exe'
    );
  });

  it('仅 setup 包：便携态退而取 setup（尽力而为）', () => {
    const only = [A('FlowZ-4.0.4-win-x64-setup.exe')];
    expect(findSuitableUpdateAsset(only, 'win32', 'x64', true)?.name).toBe(
      'FlowZ-4.0.4-win-x64-setup.exe'
    );
  });

  it('仅 portable 包：安装态退而取 portable', () => {
    const only = [A('FlowZ-4.0.4-win-x64-portable.exe')];
    expect(findSuitableUpdateAsset(only, 'win32', 'x64', false)?.name).toBe(
      'FlowZ-4.0.4-win-x64-portable.exe'
    );
  });

  it('无 Windows .exe → null', () => {
    const noWin = [A('FlowZ-4.0.4-mac-arm64.dmg'), A('FlowZ-4.0.4-linux-amd64.deb')];
    expect(findSuitableUpdateAsset(noWin, 'win32', 'x64', true)).toBeNull();
  });

  it('空资产 → null（守 winExe.length===0）', () => {
    expect(findSuitableUpdateAsset([], 'win32', 'x64', true)).toBeNull();
    expect(findSuitableUpdateAsset([], 'win32', 'x64', false)).toBeNull();
  });

  it('畸形双词包（名含 setup 又含 portable）→ 行为按数组首个命中（钉死现状）', () => {
    // electron-builder 不会产出这种名字；此处仅钉死 find 短路语义、防无声漂移。
    const malformed = [A('FlowZ-portable-setup.exe-win.exe'), A('FlowZ-win-x64-portable.exe')];
    // 便携态：isPortable 先命中首个畸形包
    expect(findSuitableUpdateAsset(malformed, 'win32', 'x64', true)?.name).toBe(
      'FlowZ-portable-setup.exe-win.exe'
    );
  });
});

describe('findSuitableUpdateAsset — mac/linux 保持原行为', () => {
  it('darwin arm64 → mac-arm64 .dmg', () => {
    expect(findSuitableUpdateAsset(RELEASE, 'darwin', 'arm64', false)?.name).toBe(
      'FlowZ-4.0.4-mac-arm64.dmg'
    );
  });

  it('darwin x64 有 mac-x64 包 → 精确命中 mac-x64', () => {
    const withX64 = [...RELEASE, A('FlowZ-4.0.4-mac-x64.dmg')];
    expect(findSuitableUpdateAsset(withX64, 'darwin', 'x64', false)?.name).toBe(
      'FlowZ-4.0.4-mac-x64.dmg'
    );
  });

  it('darwin x64 无 mac-x64 包 → 回退任意 .dmg', () => {
    expect(findSuitableUpdateAsset(RELEASE, 'darwin', 'x64', false)?.name).toBe(
      'FlowZ-4.0.4-mac-arm64.dmg'
    );
  });

  it('linux → AppImage 优先', () => {
    expect(findSuitableUpdateAsset(RELEASE, 'linux', 'x64', false)?.name).toBe(
      'FlowZ-4.0.4-linux-x86_64.AppImage'
    );
  });

  it('linux 无 AppImage → 回退 .deb', () => {
    const debOnly = [A('FlowZ-4.0.4-linux-amd64.deb'), A('FlowZ-4.0.4-mac-arm64.dmg')];
    expect(findSuitableUpdateAsset(debOnly, 'linux', 'x64', false)?.name).toBe(
      'FlowZ-4.0.4-linux-amd64.deb'
    );
  });

  it('未知平台 → null', () => {
    expect(findSuitableUpdateAsset(RELEASE, 'freebsd' as NodeJS.Platform, 'x64', false)).toBeNull();
  });
});
