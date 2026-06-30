/**
 * 更新安装脚本生成（#72 P2/B6）：钉死三平台 loose 原位更新的关键操作与回退分支、引号转义。
 * 执行是真机项；本测只验生成的脚本字符串结构正确。
 */
import {
  buildWindowsUpdateVbs,
  buildLinuxAppImageScript,
  buildLinuxDebScript,
  buildMacUpdateScript,
  macAppBundleFromExe,
  selectPortableStaleOld,
} from '../update-install-script';

describe('buildWindowsUpdateVbs', () => {
  const tmp = 'C:\\Users\\u\\AppData\\Local\\Temp\\FlowZ-4.1.7-win-x64-portable.exe';

  it('便携态（B 移入新名+删旧名）：写新版本名到原目录 + 删旧名(被锁则 rename 兜底) + 启新名 + 不静默 fallback', () => {
    const oldExe = 'D:\\Apps\\FlowZ-4.1.5-win-x64-portable.exe';
    const newExe = 'D:\\Apps\\FlowZ-4.1.7-win-x64-portable.exe';
    const s = buildWindowsUpdateVbs({
      installerPath: tmp,
      portableTarget: oldExe,
      portableNewPath: newExe,
      fallbackMessage: 'UPD_FAIL_MSG',
    });
    // 变量赋值（双反斜杠转义）
    expect(s).toContain('newExe = "D:\\\\Apps\\\\FlowZ-4.1.7-win-x64-portable.exe"');
    expect(s).toContain('oldExe = "D:\\\\Apps\\\\FlowZ-4.1.5-win-x64-portable.exe"');
    // 写新版本名文件到原目录（新名不撞锁）
    expect(s).toContain('fso.CopyFile src, newExe, True');
    // 旧名被 stub 锁 → DeleteFile 失败则 rename 到 .old；同名时跳过删旧
    expect(s).toContain('LCase(oldExe) <> LCase(newExe)');
    expect(s).toContain('fso.DeleteFile oldExe, True');
    expect(s).toContain('fso.MoveFile oldExe, oldExe & ".old"');
    // 启动新版本名文件
    expect(s).toContain('WshShell.Run """" & newExe & """", 1, False');
    // 残留 .old 清理（新旧两路径）+ newExe 预存则先 rename 挪开
    expect(s).toContain(
      'If fso.FileExists(newExe & ".old") Then fso.DeleteFile newExe & ".old", True'
    );
    expect(s).toContain(
      'If fso.FileExists(oldExe & ".old") Then fso.DeleteFile oldExe & ".old", True'
    );
    expect(s).toContain('If fso.FileExists(newExe) Then fso.MoveFile newExe, newExe & ".old"');
    // 写新名失败 fallback：跑临时 src + MsgBox（含注入文案 + 单反斜杠原路径，非双写反斜杠）
    expect(s).toContain('WshShell.Run """" & src & """", 1, False');
    expect(s).toContain('MsgBox "UPD_FAIL_MSG"');
    expect(s).toContain('"C:\\Users\\u\\AppData\\Local\\Temp\\FlowZ-4.1.7-win-x64-portable.exe"');
    expect(s).toMatch(/\r\n/); // VBS 用 CRLF
  });

  it('便携态 portableNewPath 缺省 → 退化为覆盖同名（newExe == oldExe）', () => {
    const target = 'D:\\Apps\\FlowZ.exe';
    const s = buildWindowsUpdateVbs({ installerPath: tmp, portableTarget: target });
    expect(s).toContain('newExe = "D:\\\\Apps\\\\FlowZ.exe"');
    expect(s).toContain('oldExe = "D:\\\\Apps\\\\FlowZ.exe"');
  });

  it('NSIS 态：跑下载的 setup、无 CopyFile（原行为）', () => {
    const s = buildWindowsUpdateVbs({ installerPath: tmp, portableTarget: null });
    expect(s).toContain(
      'WshShell.Run """C:\\\\Users\\\\u\\\\AppData\\\\Local\\\\Temp\\\\FlowZ-4.1.7-win-x64-portable.exe"""'
    );
    expect(s).not.toContain('fso.CopyFile');
  });
});

describe('selectPortableStaleOld', () => {
  it('只筛本产品 <prefix>…portable.exe.old，不误删同目录他人 .exe.old', () => {
    expect(
      selectPortableStaleOld([
        'FlowZ-4.1.5-win-x64-portable.exe.old',
        'FlowZ-4.1.7-win-x64-portable.exe',
        'Other.EXE.OLD', // 他家工具 → 不删
        'Foo-portable.exe.old', // 非 FlowZ 前缀 → 不删
        'data',
        'config.json',
      ])
    ).toEqual(['FlowZ-4.1.5-win-x64-portable.exe.old']);
  });

  it('自定义 productPrefix', () => {
    expect(selectPortableStaleOld(['MyApp-1.0-portable.exe.old'], 'MyApp-')).toEqual([
      'MyApp-1.0-portable.exe.old',
    ]);
  });

  it('无匹配（非 portable 的 .old / 缺前缀）→ 空数组', () => {
    expect(selectPortableStaleOld(['a.exe', 'b.txt', 'c.old', 'FlowZ-x.exe'])).toEqual([]);
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

describe('buildLinuxDebScript', () => {
  it('pkexec apt-get install 原位升级 + 删 deb + 重启；失败回退 xdg-open 下载目录', () => {
    const s = buildLinuxDebScript({
      installerPath: '/tmp/FlowZ-4.1.8.deb',
      exePath: '/opt/FlowZ/flowz',
    });
    expect(s).toContain("DEB='/tmp/FlowZ-4.1.8.deb'");
    expect(s).toContain("EXE='/opt/FlowZ/flowz'");
    expect(s).toContain('pkexec apt-get install -y'); // apt 解依赖+版本升级（非 openPath→App Center）
    expect(s).toContain('Dpkg::Options::=--force-confold'); // 无 tty conffile 防阻断（Low-1）
    expect(s).toMatch(/pkexec apt-get install .*"\$DEB"/); // deb 路径作末参
    expect(s).toContain('rm -f "$DEB"'); // 成功删临时 deb
    expect(s).toContain('nohup "$EXE"'); // 同路径覆盖后从原 exe 启动新版
    expect(s).toContain('xdg-open "$(dirname "$DEB")"'); // 取消/失败回退（不回 openPath）
    expect(s.startsWith('#!/bin/bash')).toBe(true);
  });

  it('单引号路径安全转义', () => {
    const s = buildLinuxDebScript({ installerPath: "/tmp/it's.deb", exePath: '/o/f' });
    expect(s).toContain("DEB='/tmp/it'\\''s.deb'");
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
