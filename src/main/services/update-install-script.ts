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

/**
 * Windows 更新 VBS。portableTarget 非空=便携态（覆盖回原 exe 再启动）；否则=NSIS（运行下载的 setup，原行为逐字保留）。
 * 便携只覆盖 exe 一个文件，exe 同级 `data\`（config/core_update/rules）原样保留。
 */
export function buildWindowsUpdateVbs(opts: {
  installerPath: string;
  portableTarget?: string | null;
}): string {
  const src = vbsPath(opts.installerPath);
  if (opts.portableTarget) {
    const dst = vbsPath(opts.portableTarget);
    return [
      'WScript.Sleep 2000',
      'Set WshShell = CreateObject("WScript.Shell")',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'On Error Resume Next',
      // 只覆盖便携 exe 这一个文件（运行进程实跑在 %TEMP% 解压副本，原 exe 未被锁，可覆盖）；
      // exe 同级 data\ 不动 → 用户配置 + 已更新内核(core_update) 零丢失。
      `fso.CopyFile "${src}", "${dst}", True`,
      'If Err.Number = 0 Then',
      '  Err.Clear',
      // 覆盖成功 → 从原位置启动新版（持久更新），并清掉临时下载包
      `  WshShell.Run """${dst}""", 1, False`,
      `  fso.DeleteFile "${src}", True`,
      'Else',
      '  Err.Clear',
      // 覆盖失败（原位只读/占用）→ 退回跑临时副本，至少本次拿到新版（不删临时包）
      `  WshShell.Run """${src}""", 1, False`,
      'End If',
      'On Error Goto 0',
      'fso.DeleteFile WScript.ScriptFullName, True',
    ].join('\r\n');
  }
  // NSIS 安装态：与旧 installUpdate 逐字等价（运行 setup + 删自身）。NSIS 据注册表记住的目录原位升级、不动 %APPDATA% data。
  return [
    'WScript.Sleep 2000',
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run """${src}""", 1, False`,
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
 * 信任边界（review Med-1）：本脚本以 root 自动安装【下载的 deb】，信任源 = GitHub HTTPS release（与 core/AppImage
 * 更新同边界）。未对下载件做 sha256 比对——完整性靠 HTTPS 传输；旧 openPath 行为同样安装未校验 deb，仅多一步用户手动
 * 确认，信任源不变（仍是同一 release 资产）。sha256 校验作为后续统一增强（覆盖 deb/AppImage/core 三类下载件），不在本
 * PR 范围；调用方仅在「形态为 .deb」时才走本脚本（见 installUpdate 的 .deb 守卫，Med-2）。
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
    // （Electron 应用通常无 conffiles，防御性，review Low-1）。pkexec 弹 PolicyKit GUI 授权框（root 提权）。
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
 * brick 安全（review H1/H2）：替换一律「mv 暂存↔目标」，**绝不先 rm 目标再建**；任一步失败回滚旧版、**保留 $BAK 不删**；
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
