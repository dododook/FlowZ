/**
 * findSuitableUpdateAsset 纯逻辑（#72）：按运行形态（loose vs installed）选对应包，跨平台不串台。
 * looseForm = 当前是否以 loose 形态运行（win: 便携 / linux: AppImage；mac 不用）。
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
  it('loose(便携) → portable.exe', () => {
    expect(findSuitableUpdateAsset(RELEASE, 'win32', 'x64', true)?.name).toBe(
      'FlowZ-4.0.4-win-x64-portable.exe'
    );
  });

  it('installed(NSIS) → setup.exe', () => {
    expect(findSuitableUpdateAsset(RELEASE, 'win32', 'x64', false)?.name).toBe(
      'FlowZ-4.0.4-win-x64-setup.exe'
    );
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

  it('仅 setup 包：loose 退而取 setup（尽力而为）', () => {
    const only = [A('FlowZ-4.0.4-win-x64-setup.exe')];
    expect(findSuitableUpdateAsset(only, 'win32', 'x64', true)?.name).toBe(
      'FlowZ-4.0.4-win-x64-setup.exe'
    );
  });

  it('仅 portable 包：installed 退而取 portable', () => {
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
    const malformed = [A('FlowZ-portable-setup.exe-win.exe'), A('FlowZ-win-x64-portable.exe')];
    expect(findSuitableUpdateAsset(malformed, 'win32', 'x64', true)?.name).toBe(
      'FlowZ-portable-setup.exe-win.exe'
    );
  });
});

describe('findSuitableUpdateAsset — Linux AppImage/deb 形态感知 (#72)', () => {
  it('loose(AppImage 运行) → .AppImage', () => {
    expect(findSuitableUpdateAsset(RELEASE, 'linux', 'x64', true)?.name).toBe(
      'FlowZ-4.0.4-linux-x86_64.AppImage'
    );
  });

  it('installed(deb) → .deb（修旧逻辑恒先 AppImage 致 deb 用户被错配）', () => {
    expect(findSuitableUpdateAsset(RELEASE, 'linux', 'x64', false)?.name).toBe(
      'FlowZ-4.0.4-linux-amd64.deb'
    );
  });

  it('loose 但无 AppImage → 回退 .deb', () => {
    const debOnly = [A('FlowZ-4.0.4-linux-amd64.deb')];
    expect(findSuitableUpdateAsset(debOnly, 'linux', 'x64', true)?.name).toBe(
      'FlowZ-4.0.4-linux-amd64.deb'
    );
  });

  it('installed 但无 deb → 回退 AppImage', () => {
    const appOnly = [A('FlowZ-4.0.4-linux-x86_64.AppImage')];
    expect(findSuitableUpdateAsset(appOnly, 'linux', 'x64', false)?.name).toBe(
      'FlowZ-4.0.4-linux-x86_64.AppImage'
    );
  });

  it('无 linux 包 → null', () => {
    const noLinux = [A('FlowZ-4.0.4-mac-arm64.dmg')];
    expect(findSuitableUpdateAsset(noLinux, 'linux', 'x64', true)).toBeNull();
  });
});

describe('findSuitableUpdateAsset — macOS（不分形态）', () => {
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

  it('未知平台 → null', () => {
    expect(findSuitableUpdateAsset(RELEASE, 'freebsd' as NodeJS.Platform, 'x64', false)).toBeNull();
  });
});
