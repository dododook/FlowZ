/**
 * 更新安装脚本生成（纯字符串，便于 Linux 单测钉死 Windows/macOS/Linux 引号与回退分支；执行是真机项）。
 *
 * #72 loose 形态原位更新（无安装器，需显式覆盖单文件）：
 * - Windows 便携：覆盖回原便携 exe（`PORTABLE_EXECUTABLE_FILE`）再从原位启动。
 * - Linux AppImage：覆盖回原 `$APPIMAGE` 文件 + chmod+x 再启动。
 * - macOS .app：自动挂载 DMG → 暂存 → 原子替换 `/Applications/FlowZ.app`（带备份回滚）→ 重启。
 * 失败一律回退原行为（跑临时副本 / open DMG），绝不留破损件。
 *
 * 「只换单个产物文件、不碰用户数据」不变量（loose 形态原位更新安全的根据）：
 *   配置/已更新内核/规则都在**独立的 data 目录**，不在产物文件里——
 *   · Windows 便携：`<exe 同级>\data\`（config + core_update + rules）
 *   · Linux AppImage：`~/.config/FlowZ`（XDG userData）
 *   · macOS：`~/Library/Application Support/FlowZ`
 *   故覆盖 exe / AppImage / .app 单个产物 → data 原样保留 → 用户配置与已更新内核零丢失。
 *   installed 形态（NSIS / dpkg）由安装器自身原位升级，亦不动各自 data 目录。
 */

import { shq } from '../utils/shell-quote';

/** VBS 字符串字面量里的反斜杠按既有约定双写（与旧 installUpdate 一致，Windows 容忍双反斜杠路径）。 */
const vbsPath = (p: string): string => p.replace(/\\/g, '\\\\');

/** VBS 字符串字面量里的双引号双写转义（MsgBox 等含文本的串）。 */
const vbsStr = (s: string): string => s.replace(/"/g, '""');

/**
 * portable 自更新遗留的【本产品】`.exe.old`（旧版本被 stub 锁时 rename 留下）筛选——只匹配
 * 「<productPrefix>…portable.exe.old」，避免误删同目录其它便携工具的 `.exe.old`；IO 分离便于单测，启动期据此清理。
 */
export function selectPortableStaleOld(fileNames: string[], productPrefix = 'FlowZ-'): string[] {
  const p = productPrefix.toLowerCase();
  return fileNames.filter((f) => {
    const l = f.toLowerCase();
    return l.startsWith(p) && l.endsWith('portable.exe.old');
  });
}

/**
 * Windows 更新 VBS。portableTarget 非空=便携态；否则=NSIS（运行下载的 setup，原行为逐字保留）。
 *
 * 便携态（B：移入新版本名 + 删旧版本名）：把下载的【新版本名】文件移入原目录、删除【旧版本名】文件——保留
 * GitHub release 带版本号的命名（手动下载可区分版本），更新后目录里只剩对齐实际版本的那个文件。
 * 关键（治"退出重开复原旧版"bug）：portable 原 exe 是被 stub launcher 锁住的自解压包，**不能被覆盖/删除，但能被
 * rename**（Windows loader 用 FILE_SHARE_DELETE 映射映像）。故：
 *  - 新版本名文件原本不存在 → 直接写（不撞锁）；若同名已存在（重装同版本）则先 rename 挪开。
 *  - 旧版本名文件被锁 → DeleteFile 失败时**才** rename 到 `.old`（删旧的兜底，运行中可 rename），下次启动清
 *    （selectPortableStaleOld）。即主操作是「移入 + 删旧」，rename 仅删旧失败时兜锁，非「改名」。
 * exe 同级 `data\`（config/core_update/rules）不动 → 用户配置 + 已更新内核零丢失。
 * portableNewPath 缺省=portableTarget（退化为覆盖同名）。覆盖最终失败 → 不静默：跑临时新版 + MsgBox 提示手动替换。
 */
export function buildWindowsUpdateVbs(opts: {
  installerPath: string;
  portableTarget?: string | null;
  /** 新版本名文件在原目录的目标路径（= 原目录 + 下载件文件名）；缺省退化为覆盖 portableTarget 同名。 */
  portableNewPath?: string | null;
  /** 覆盖最终失败时的 MsgBox 提示（i18n，调用方注入；默认英文）。 */
  fallbackMessage?: string;
}): string {
  const src = vbsPath(opts.installerPath);
  if (opts.portableTarget) {
    const oldExe = vbsPath(opts.portableTarget);
    const newExe = vbsPath(opts.portableNewPath || opts.portableTarget);
    const msg = vbsStr(
      opts.fallbackMessage ||
        'FlowZ auto-update could not replace the portable executable. The new version was downloaded to the path below — please replace it manually:'
    );
    // MsgBox 显示用单反斜杠原路径（src 变量是双写反斜杠、给文件操作"容忍"用，直接展示/粘贴资源管理器不友好）。
    const srcDisplay = vbsStr(opts.installerPath);
    return [
      'WScript.Sleep 2000',
      'Set WshShell = CreateObject("WScript.Shell")',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      `src = "${src}"`,
      `oldExe = "${oldExe}"`,
      `newExe = "${newExe}"`,
      'On Error Resume Next',
      // 清上次残留 .old（新旧两路径都清）
      'If fso.FileExists(newExe & ".old") Then fso.DeleteFile newExe & ".old", True',
      'If fso.FileExists(oldExe & ".old") Then fso.DeleteFile oldExe & ".old", True',
      'Err.Clear',
      // 新版本名文件若已存在（重装同版本/残留且被锁）→ rename 挪开，腾出原名
      'If fso.FileExists(newExe) Then fso.MoveFile newExe, newExe & ".old"',
      'Err.Clear',
      // 写新版本名文件到原目录（新名通常不存在、不撞锁，直接成功）
      'fso.CopyFile src, newExe, True',
      'If Err.Number = 0 Then',
      '  Err.Clear',
      // 移除旧版本名文件（与新名不同时）：被 stub 锁 → DeleteFile 失败则 rename 到 .old，下次启动清
      '  If LCase(oldExe) <> LCase(newExe) Then',
      '    fso.DeleteFile oldExe, True',
      '    If Err.Number <> 0 Then',
      '      Err.Clear',
      '      fso.MoveFile oldExe, oldExe & ".old"',
      '    End If',
      '  End If',
      '  Err.Clear',
      // 从原目录新版本名文件启动新版 + 删临时下载件
      '  WshShell.Run """" & newExe & """", 1, False',
      '  fso.DeleteFile src, True',
      'Else',
      // 写新名失败（极罕见：原目录只读）→ 不静默：跑临时新版 + 明确提示用户手动替换
      '  Err.Clear',
      '  WshShell.Run """" & src & """", 1, False',
      `  MsgBox "${msg}" & vbCrLf & "${srcDisplay}", 48, "FlowZ"`,
      'End If',
      'On Error Goto 0',
      'fso.DeleteFile WScript.ScriptFullName, True',
    ].join('\r\n');
  }
  // NSIS 安装态：运行 setup + 删自身。NSIS 据注册表记住的目录原位升级、不动 %APPDATA% data。
  //
  // `--updated` 不可省（#312 任务栏固定每次更新丢失的根因）：NSIS 的 ${isUpdated} 谓词 = 「命令行含 --updated」
  // （StdUtils.TestParameter，见 app-builder-lib templates/nsis/include/*.nsh）。本项目设了
  // allowToChangeInstallationDirectory → installUtil.nsh 的 setIsTryToKeepShortcuts 在 ${ifNot} ${isUpdated}
  // 时把 $isTryToKeepShortcuts 置 false → 新安装器不给旧版卸载器传 --keep-shortcuts → 旧卸载器执行
  // WinShell::UninstShortcut（= IStartMenuPinnedList::RemoveFromList）**显式取消任务栏固定**；随后安装段只重建
  // 桌面/开始菜单快捷方式，故症状是「唯独任务栏 pin 每次更新丢」。Windows 无程序化重新固定的 API，删了只能手动加回。
  // **滞后一版生效**：本 VBS 由「当前运行的旧版 app」生成 → 升级到含本修复的那一版时，跑脚本的仍是不带
  // --updated 的旧版，pin 仍会丢最后一次；自本版 → 下一版起才保住。（旧版卸载器本身支持 --keep-shortcuts，
  // 缺的只是旧版 VBS 不传 --updated。）release note 需写明，否则会收到「升级到修复版还是丢了」的无效反馈。
  //
  // 附带行为变化两条：
  // ① 激活 skipPageIfUpdated → 更新时跳过欢迎/目录页（已装机不再问安装目录，杜绝装出第二个目录）。
  // ② $keepShortcuts=true 后 addStartMenuLink/addDesktopLink（installer.nsh:189-243）不再无条件重建快捷方式
  //    → 用户手动删掉的桌面/开始菜单快捷方式，更新后不再被重建（FlowZ createDesktopShortcut:true 非 "always"、
  //    无 RECREATE define）。此为 electron-updater 生态标准语义，算改进。注意上文第 6 环描述的「安装段重建
  //    快捷方式」是**修复前**的行为，勿与此处混读。
  // 与 electron-updater 官方行为一致（NsisUpdater.ts 恒传 ["--updated"]）。
  return [
    'WScript.Sleep 2000',
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run """${src}"" --updated", 1, False`,
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'fso.DeleteFile WScript.ScriptFullName, True',
  ].join('\r\n');
}

/**
 * Linux AppImage 原位更新脚本：覆盖回原 `$APPIMAGE` 文件 + chmod+x + 重启；失败退回跑临时新版。
 * 只换 AppImage 一个文件，`~/.config/FlowZ`（config/core_update/rules）不动 → 用户数据零丢失。
 * deb 安装态不走此函数（installUpdate 仍 openPath(.deb) 交 dpkg 原位升级）。
 */
export function buildLinuxAppImageScript(opts: {
  installerPath: string;
  appImageTarget: string;
}): string {
  const src = shq(opts.installerPath);
  const dst = shq(opts.appImageTarget);
  return [
    '#!/bin/bash',
    'sleep 2',
    `NEW=${src}`,
    `DEST=${dst}`,
    // 只覆盖 AppImage 这一个文件；~/.config/FlowZ 不动 → 配置 + 已更新内核零丢失。
    'if cp -f "$NEW" "$DEST" 2>/dev/null; then',
    '  chmod +x "$DEST" 2>/dev/null',
    '  rm -f "$NEW" 2>/dev/null',
    '  nohup "$DEST" >/dev/null 2>&1 &',
    'else',
    // 覆盖失败（原 AppImage 只读/无权限）→ 跑临时新版，至少本次拿到新版（不删临时）
    '  chmod +x "$NEW" 2>/dev/null',
    '  nohup "$NEW" >/dev/null 2>&1 &',
    'fi',
    '',
  ].join('\n');
}

/**
 * Linux deb 安装态原位升级脚本：`pkexec apt-get install` 原位升级（apt 比较版本 + 解依赖 + 同包名升级，dpkg 同
 * 路径覆盖）+ 重启新版。取代旧 `shell.openPath(.deb)`——Ubuntu 24.04+ 默认 .deb 处理器是 App Center，对本地 .deb
 * 只按【包名】判「已安装」、不比较版本、不提供升级流程（已装即显示 Installed 灰按钮，deb 用户无法 app 内升级）。
 * data 在 `~/.config/FlowZ` 独立于产物 → 升级零丢失。提权用 pkexec（PolicyKit GUI 授权框，Ubuntu 标准；app 已
 * 退出，框独立弹出）；用户取消/失败 → 回退 `xdg-open` 下载目录让用户手动处理（不回退 openPath→App Center 死路）。
 *
 * 信任边界：本脚本以 root 自动安装【下载的 deb】，信任源 = GitHub HTTPS release（与 core/AppImage
 * 更新同边界）。未对下载件做 sha256 比对——完整性靠 HTTPS 传输；旧 openPath 行为同样安装未校验 deb，仅多一步用户手动
 * 确认，信任源不变（仍是同一 release 资产）。sha256 校验作为后续统一增强（覆盖 deb/AppImage/core 三类下载件），不在本
 * PR 范围；调用方仅在「形态为 .deb」时才走本脚本（见 installUpdate 的 .deb 守卫）。
 */
export function buildLinuxDebScript(opts: { installerPath: string; exePath: string }): string {
  const deb = shq(opts.installerPath);
  const exe = shq(opts.exePath);
  return [
    '#!/bin/bash',
    'sleep 2',
    `DEB=${deb}`,
    `EXE=${exe}`,
    // apt-get install 本地 deb（apt 1.1+ 支持绝对路径 deb）：解依赖 + 同包名版本升级。-y 免交互确认（apt 层）。
    // -o Dpkg::Options::=--force-conf*：无 tty/detached 下若 deb 含 conffile 冲突，保留旧配置不阻断 install
    // （Electron 应用通常无 conffiles，防御性）。pkexec 弹 PolicyKit GUI 授权框（root 提权）。
    // 成功 → 删临时 deb + 从原 exe 路径启动新版（dpkg 同路径覆盖）。
    'if pkexec apt-get install -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$DEB"; then',
    '  rm -f "$DEB" 2>/dev/null',
    '  nohup "$EXE" >/dev/null 2>&1 &',
    'else',
    // 用户取消授权 / apt 失败 → 打开下载目录让用户手动（不回退 openPath，那会落回 App Center「Installed 无升级」死路）。
    '  xdg-open "$(dirname "$DEB")" >/dev/null 2>&1 &',
    'fi',
    '',
  ].join('\n');
}

/**
 * macOS 更新脚本（原子替换，避免 DMG 累积）。appBundlePath 非空=自动替换 .app；为空（定位不到 .app）=回退 open DMG。
 * 提权策略：先**无提权** mv 原子替换（/Applications 对 admin 用户组可写，绝大多数免密码）；失败才 osascript 一次性
 * 管理员授权（系统原生密码框，**不依赖常驻 helper**）。
 * brick 安全：替换一律「mv 暂存↔目标」，**绝不先 rm 目标再建**；任一步失败回滚旧版、**保留 $BAK 不删**；
 * 提权步骤把替换命令落盘成脚本、osascript 只跑 `bash '<脚本>'`（单层引号，复用 runRootScript 套路；路径经 printf %q
 * 转义，免三层引号脆弱性）；仅当 $DEST 确为新版到位才善后（删 BAK/STAGE/DMG），否则保留可恢复 + 回退手动。
 */
export function buildMacUpdateScript(opts: {
  dmgPath: string;
  appBundlePath?: string | null;
}): string {
  const dmg = shq(opts.dmgPath);
  if (!opts.appBundlePath) {
    return ['#!/bin/bash', 'sleep 2', `open ${dmg}`, ''].join('\n');
  }
  const dest = shq(opts.appBundlePath);
  return [
    '#!/bin/bash',
    'sleep 2',
    `DMG=${dmg}`,
    `DEST=${dest}`,
    'BAK="$DEST.bak-$$"',
    'STAGE="$(dirname "$DEST")/.flowz-update-$$.app"',
    // 清历史中断遗留的暂存（M2，防 /Applications 下 .flowz-update-*.app 垃圾堆积）
    'rm -rf "$(dirname "$DEST")"/.flowz-update-*.app 2>/dev/null',
    // 挂载 DMG（失败=极罕见→回退手动 open，唯一保留 DMG 的分支）
    'MNT=$(hdiutil attach "$DMG" -nobrowse -noautoopen -mountrandom /tmp 2>/dev/null | grep -o "/tmp/[^[:space:]]*" | tail -1)',
    '[ -z "$MNT" ] && { open "$DMG"; exit 0; }',
    'SRC=$(/usr/bin/find "$MNT" -maxdepth 1 -name "*.app" | head -1)',
    '[ -z "$SRC" ] && { hdiutil detach "$MNT" >/dev/null 2>&1; rm -f "$DMG"; exit 0; }',
    // 整包暂存到目标同卷（mv 原子），失败即清理退出
    'rm -rf "$STAGE"',
    'if ! ditto "$SRC" "$STAGE"; then hdiutil detach "$MNT" >/dev/null 2>&1; rm -rf "$STAGE"; rm -f "$DMG"; exit 0; fi',
    'hdiutil detach "$MNT" >/dev/null 2>&1',
    // 原子替换（mv-swap，绝不先毁后建；失败回滚旧版、保留 $BAK 可恢复）。先尝试无提权。
    'replace() {',
    '  mv "$DEST" "$BAK" 2>/dev/null || return 1',
    '  if mv "$STAGE" "$DEST" 2>/dev/null; then rm -rf "$BAK"; return 0; fi',
    '  mv "$BAK" "$DEST" 2>/dev/null; return 1',
    '}',
    'if ! replace; then',
    // 无提权失败 → 把同一 mv-swap 落盘成脚本（路径 printf %q 转义），osascript 一次性 root 跑 `bash '<脚本>'`（单层引号）
    '  ELEV="$(dirname "$DEST")/.flowz-elev-$$.sh"',
    '  cat > "$ELEV" <<EOF',
    '#!/bin/bash',
    'mv $(printf %q "$DEST") $(printf %q "$BAK") || exit 1',
    'mv $(printf %q "$STAGE") $(printf %q "$DEST") || { mv $(printf %q "$BAK") $(printf %q "$DEST"); exit 1; }',
    'rm -rf $(printf %q "$BAK")',
    'EOF',
    '  osascript -e "do shell script \\"/bin/bash \'$ELEV\'\\" with administrator privileges" 2>/dev/null',
    '  rm -f "$ELEV"',
    'fi',
    // 仅当新版确到位（$DEST 存在且无残留 $BAK=替换成功）才善后；失败则 $BAK/$STAGE 保留可人工恢复、不删 DMG 便于重试
    'if [ -d "$DEST" ] && [ ! -d "$BAK" ]; then',
    '  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null',
    '  rm -rf "$STAGE" 2>/dev/null',
    '  rm -f "$DMG"',
    '  open "$DEST"',
    'else',
    '  open "$DMG"',
    'fi',
    '',
  ].join('\n');
}

/** 从可执行路径推导 .app 包路径（/Applications/FlowZ.app/Contents/MacOS/FlowZ → /Applications/FlowZ.app）；不匹配返回 null。 */
export function macAppBundleFromExe(exePath: string): string | null {
  const m = exePath.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/);
  return m ? m[1] : null;
}
