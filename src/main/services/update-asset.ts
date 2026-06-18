/**
 * App 更新安装包的资产选择（纯逻辑，process 平台/架构/运行形态由调用方注入，便于单测）。
 *
 * 与 singbox-asset.findSuitableSingboxAsset 同模式：UpdateService.findSuitableAsset 仅注入 process.*。
 *
 * #72：每平台都有「loose（无安装器，单文件原位跑）」与「installed（经安装器/包管理器）」两形态，
 * 必须按**当前运行形态**选对应包，否则错配（如便携被发 NSIS setup → 装出多余副本「凭空多一个 flowz」）。
 *   - Windows：portable.exe(loose) / nsis setup.exe(installed)
 *   - Linux：  AppImage(loose) / .deb(installed)
 *   - macOS：  只有 DMG（.app 始终 loose），不分形态。
 * `looseForm` = 当前是否以 loose 形态运行（win: PORTABLE_EXECUTABLE_DIR / linux: APPIMAGE；mac 不用）。
 */
export function findSuitableUpdateAsset(
  assets: any[],
  platform: NodeJS.Platform,
  arch: string,
  looseForm: boolean
): any | null {
  if (platform === 'win32') {
    // 保持旧筛选口径（.exe 且名含 'win'），仅在其中按运行形态消歧 setup/portable。
    const winExe = assets.filter((a: any) => a.name.endsWith('.exe') && a.name.includes('win'));
    if (winExe.length === 0) return null;
    // 名字同含 setup 与 portable 的畸形包未定义（electron-builder 不产出），按 find 短路=数组首个命中，
    // 不为它牺牲正常包的「顺序无关」（见 update-asset.test.ts 钉死现状）。
    const isPortable = (a: any) => a.name.toLowerCase().includes('portable');
    const isSetup = (a: any) => a.name.toLowerCase().includes('setup');
    if (looseForm) {
      // 便携(loose)：取 portable 包；无则退取非 setup；再不行取首个（单包 release 兜底）。
      return winExe.find(isPortable) ?? winExe.find((a: any) => !isSetup(a)) ?? winExe[0];
    }
    // 安装(NSIS)：取 setup 包；无则退取非 portable；再不行取首个。
    return winExe.find(isSetup) ?? winExe.find((a: any) => !isPortable(a)) ?? winExe[0];
  } else if (platform === 'darwin') {
    const archPattern = arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
    let asset = assets.find((a: any) => a.name.includes(archPattern) && a.name.endsWith('.dmg'));
    if (!asset) {
      asset = assets.find((a: any) => a.name.endsWith('.dmg'));
    }
    return asset || null;
  } else if (platform === 'linux') {
    // 形态感知（修旧逻辑「恒先 AppImage」致 deb 用户被发 AppImage、无法经 dpkg 更新）：
    const appImage = assets.filter((a: any) => a.name.endsWith('.AppImage'));
    const deb = assets.filter((a: any) => a.name.endsWith('.deb'));
    if (looseForm) {
      // AppImage(loose) 运行：取 AppImage；无则退 .deb。
      return appImage[0] ?? deb[0] ?? null;
    }
    // deb 安装：取 .deb（dpkg 原位升级）；无则退 AppImage。
    return deb[0] ?? appImage[0] ?? null;
  }
  return null;
}
