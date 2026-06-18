/**
 * App 更新安装包的资产选择（纯逻辑，process 平台/架构/便携态由调用方注入，便于单测）。
 *
 * 与 singbox-asset.findSuitableSingboxAsset 同模式：UpdateService.findSuitableAsset 仅注入 process.*。
 *
 * #72 根因：Windows 同时发布 setup(NSIS) 与 portable 两种 .exe（electron-builder.json win.target），
 * 旧逻辑 `assets.find(.exe && includes('win'))` 取首个匹配、**不区分 setup/portable** → 便携版可能命中
 * setup 包 → 跑 NSIS 装出一份全新 FlowZ（落 %LOCALAPPDATA%\Programs\FlowZ，与便携 exe 非同处）→
 * 用户「每次更新完多一个 flowz、不知在哪」。这里按运行形态（PORTABLE_EXECUTABLE_DIR）选对应包。
 */
export function findSuitableUpdateAsset(
  assets: any[],
  platform: NodeJS.Platform,
  arch: string,
  portable: boolean
): any | null {
  if (platform === 'win32') {
    // 保持旧筛选口径（.exe 且名含 'win'），仅在其中按运行形态消歧 setup/portable。
    const winExe = assets.filter((a: any) => a.name.endsWith('.exe') && a.name.includes('win'));
    if (winExe.length === 0) return null;
    // 名字同含 setup 与 portable 的畸形包未定义（electron-builder 不产出），按 find 短路=数组首个命中，
    // 不为它牺牲正常包的「顺序无关」（见 update-asset.test.ts 钉死现状）。
    const isPortable = (a: any) => a.name.toLowerCase().includes('portable');
    const isSetup = (a: any) => a.name.toLowerCase().includes('setup');
    if (portable) {
      // 便携版：取 portable 包；无则退取非 setup；再不行取首个（单包 release 兜底）。
      return winExe.find(isPortable) ?? winExe.find((a: any) => !isSetup(a)) ?? winExe[0];
    }
    // 安装版(NSIS)：取 setup 包；无则退取非 portable；再不行取首个。
    return winExe.find(isSetup) ?? winExe.find((a: any) => !isPortable(a)) ?? winExe[0];
  } else if (platform === 'darwin') {
    const archPattern = arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
    let asset = assets.find((a: any) => a.name.includes(archPattern) && a.name.endsWith('.dmg'));
    if (!asset) {
      asset = assets.find((a: any) => a.name.endsWith('.dmg'));
    }
    return asset || null;
  } else if (platform === 'linux') {
    let asset = assets.find((a: any) => a.name.endsWith('.AppImage'));
    if (!asset) {
      asset = assets.find((a: any) => a.name.endsWith('.deb'));
    }
    return asset || null;
  }
  return null;
}
