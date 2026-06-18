/**
 * 更新安装脚本生成（#72 P2/B6）：钉死三平台 loose 原位更新的关键操作与回退分支、引号转义。
 * 执行是真机项；本测只验生成的脚本字符串结构正确。
 */
import {
  buildWindowsUpdateVbs,
  buildLinuxAppImageScript,
  buildMacUpdateScript,
  macAppBundleFromExe,
} from '../update-install-script';

describe('buildWindowsUpdateVbs', () => {
  const tmp = 'C:\\Users\\u\\AppData\\Local\\Temp\\FlowZ-portable.exe';

  it('便携态：覆盖回原 exe 原位 + 启动原位 + 删临时；含覆盖失败回退', () => {
    const target = 'D:\\Apps\\FlowZ.exe';
    const s = buildWindowsUpdateVbs({ installerPath: tmp, portableTarget: target });
    // 覆盖回原 exe（双反斜杠转义）
    expect(s).toContain(
      'fso.CopyFile "C:\\\\Users\\\\u\\\\AppData\\\\Local\\\\Temp\\\\FlowZ-portable.exe", "D:\\\\Apps\\\\FlowZ.exe", True'
    );
    // 成功 → 跑原位 + 删临时
    expect(s).toContain('WshShell.Run """D:\\\\Apps\\\\FlowZ.exe"""');
    expect(s).toContain('If Err.Number = 0 Then');
    expect(s).toContain('Else'); // 覆盖失败回退跑临时
    expect(s).toMatch(/\r\n/); // VBS 用 CRLF
  });

  it('NSIS 态：跑下载的 setup、无 CopyFile（原行为）', () => {
    const s = buildWindowsUpdateVbs({ installerPath: tmp, portableTarget: null });
    expect(s).toContain(
      'WshShell.Run """C:\\\\Users\\\\u\\\\AppData\\\\Local\\\\Temp\\\\FlowZ-portable.exe"""'
    );
    expect(s).not.toContain('fso.CopyFile');
  });
});

describe('buildLinuxAppImageScript', () => {
  it('覆盖回原 AppImage + chmod + 重启；覆盖失败回退跑临时', () => {
    const s = buildLinuxAppImageScript({
      installerPath: '/tmp/FlowZ-new.AppImage',
      appImageTarget: '/home/u/Apps/FlowZ.AppImage',
    });
    expect(s).toContain("NEW='/tmp/FlowZ-new.AppImage'");
    expect(s).toContain("DEST='/home/u/Apps/FlowZ.AppImage'");
    expect(s).toContain('cp -f "$NEW" "$DEST"');
    expect(s).toContain('chmod +x "$DEST"');
    expect(s).toContain('nohup "$DEST"');
    expect(s).toContain('nohup "$NEW"'); // 回退
    expect(s.startsWith('#!/bin/bash')).toBe(true);
  });

  it('单引号路径安全转义', () => {
    const s = buildLinuxAppImageScript({
      installerPath: "/tmp/it's.AppImage",
      appImageTarget: '/a/b.AppImage',
    });
    expect(s).toContain("NEW='/tmp/it'\\''s.AppImage'");
  });
});

describe('buildMacUpdateScript', () => {
  it('有 .app 路径：mv 原子替换 + osascript 落盘脚本提权 + 删 DMG + 重启（brick 安全 H1/H2/M2）', () => {
    const s = buildMacUpdateScript({
      dmgPath: '/tmp/FlowZ.dmg',
      appBundlePath: '/Applications/FlowZ.app',
    });
    expect(s).toContain('hdiutil attach');
    expect(s).toContain('ditto "$SRC" "$STAGE"');
    // mv-swap 原子替换 + 回滚（绝不先毁后建）
    expect(s).toContain('mv "$DEST" "$BAK"');
    expect(s).toContain('mv "$STAGE" "$DEST"');
    expect(s).toContain('mv "$BAK" "$DEST"'); // 回滚
    // H1：绝无「先 rm 目标再建」的不可恢复 brick 路径
    expect(s).not.toContain("rm -rf '$DEST'");
    // H2：提权命令落盘脚本 + osascript 单层引号跑 bash，路径 printf %q 转义（免三层引号脆弱性）
    expect(s).toContain('with administrator privileges');
    expect(s).toContain("/bin/bash '$ELEV'");
    expect(s).toContain('printf %q');
    // M2：清历史中断遗留的暂存
    expect(s).toContain('.flowz-update-*.app');
    expect(s).toContain('xattr -dr com.apple.quarantine');
    expect(s).toContain('rm -f "$DMG"'); // 删 DMG 避免累积
    expect(s).toContain('open "$DEST"');
  });

  it('无 .app 路径：回退原行为仅 open DMG', () => {
    const s = buildMacUpdateScript({ dmgPath: '/tmp/FlowZ.dmg', appBundlePath: null });
    expect(s).toContain("open '/tmp/FlowZ.dmg'");
    expect(s).not.toContain('hdiutil');
    expect(s).not.toContain('ditto');
  });
});

describe('macAppBundleFromExe', () => {
  it('标准路径 → .app 包', () => {
    expect(macAppBundleFromExe('/Applications/FlowZ.app/Contents/MacOS/FlowZ')).toBe(
      '/Applications/FlowZ.app'
    );
  });

  it('非 .app 布局 → null', () => {
    expect(macAppBundleFromExe('/usr/local/bin/flowz')).toBeNull();
    expect(macAppBundleFromExe('C:\\Apps\\FlowZ.exe')).toBeNull();
  });
});
