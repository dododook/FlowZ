/**
 * 卸载 sidecar 脚本生成单测：钉死「非 ASCII 路径全走环境变量、.bat 零非 ASCII 字面」这个治本不变量 + 三种删本体分支。
 * 执行/编码落盘是真机项；本测验生成的字符串结构。
 */
import { buildUninstallSidecar, resolveUninstallBody } from '../uninstall-sidecar';

const sys = {
  cmd: 'C:\\Windows\\System32\\cmd.exe',
  tasklist: 'C:\\Windows\\System32\\tasklist.exe',
  find: 'C:\\Windows\\System32\\find.exe',
  ping: 'C:\\Windows\\System32\\ping.exe',
};

// 中文用户名路径——本修复的核心场景。
const base = {
  flowzPid: 1234,
  userData: 'C:\\Users\\张三\\AppData\\Roaming\\flowz',
  exeDir: 'C:\\Users\\张三\\FlowZ',
  exePath: 'C:\\Users\\张三\\FlowZ\\FlowZ.exe',
  bodyTmpPath: 'C:\\Users\\张三\\AppData\\Local\\Temp\\flowz-uninstall-body-1234-99.exe',
  batPath: 'C:\\Users\\张三\\AppData\\Local\\Temp\\flowz-uninstall-1234-99.bat',
  vbsPath: 'C:\\Users\\张三\\AppData\\Local\\Temp\\flowz-uninstall-1234-99.vbs',
  sys,
};

describe('buildUninstallSidecar', () => {
  it('.bat 纯 ASCII：非 ASCII 路径不内联（全走 %VAR%），含 PID 轮询 + System32 绝对路径', () => {
    const { bat } = buildUninstallSidecar({ ...base, uninstaller: null, portableRmdir: true });
    expect([...bat].every((c) => c.charCodeAt(0) <= 0x7f)).toBe(true); // 治本不变量：.bat 里零非 ASCII 字面
    expect(bat).toContain('rmdir /s /q "%FLOWZ_USERDATA%"');
    // 删本体治本：move 本体到 %TEMP%（同卷=rename，运行中亦可，不撞 stub 运行锁），rmdir 态再删剩余安装目录
    expect(bat).toContain('move /y "%FLOWZ_EXE%" "%FLOWZ_BODYTMP%" >nul 2>nul');
    expect(bat).toContain('rmdir /s /q "%FLOWZ_EXEDIR%"'); // rmdir 态：移出 exe 后删剩余目录
    // 顺序不变量：必先 move 出 exe（解锁目录）再 rmdir 剩余，否则 rmdir 撞被锁 exe 失败
    expect(bat.indexOf('move /y "%FLOWZ_EXE%"')).toBeLessThan(
      bat.indexOf('rmdir /s /q "%FLOWZ_EXEDIR%"')
    );
    expect(bat).not.toContain(':delbody'); // 不再 del 重试（del 撞运行锁删不掉，实测残留）
    expect(bat).not.toContain('del /f /q "%FLOWZ_EXE%"');
    expect(bat).toContain('del /f /q "%FLOWZ_VBS%"');
    expect(bat).toContain('del "%~f0"'); // N3：自删
    expect(bat).toContain('set "FLOWZ_PID=1234"');
    expect(bat).toContain('C:\\Windows\\System32\\tasklist.exe');
    expect(bat).toContain('if %WAIT% GEQ 60 goto clean'); // 60s 上限防卡死
    expect(bat).toMatch(/\r\n/);
  });

  it('.vbs 设环境变量为 Unicode 路径（含中文）+ 隐藏启动 cmd', () => {
    const { vbs } = buildUninstallSidecar({ ...base, uninstaller: null, portableRmdir: true });
    expect(vbs).toContain('Set e = s.Environment("PROCESS")');
    expect(vbs).toContain('e("FLOWZ_USERDATA") = "C:\\Users\\张三\\AppData\\Roaming\\flowz"');
    expect(vbs).toContain('e("FLOWZ_EXE") = "C:\\Users\\张三\\FlowZ\\FlowZ.exe"'); // move 源
    expect(vbs).toContain(
      'e("FLOWZ_BODYTMP") = "C:\\Users\\张三\\AppData\\Local\\Temp\\flowz-uninstall-body-1234-99.exe"'
    ); // move 目标
    expect(vbs).toContain('e("FLOWZ_EXEDIR") = "C:\\Users\\张三\\FlowZ"'); // rmdir 剩余目录
    // N3：.vbs 须设 FLOWZ_VBS（否则 .bat 删不掉 .vbs，残留 temp）+ batPath 内联进 .Run（中文 batPath 靠 UTF-16）。
    expect(vbs).toContain(
      'e("FLOWZ_VBS") = "C:\\Users\\张三\\AppData\\Local\\Temp\\flowz-uninstall-1234-99.vbs"'
    );
    expect(vbs).toContain(
      's.Run """C:\\Windows\\System32\\cmd.exe"" /c ""C:\\Users\\张三\\AppData\\Local\\Temp\\flowz-uninstall-1234-99.bat""", 0, False'
    );
    expect(vbs).toMatch(/\r\n/);
  });

  it('installed（有卸载器）：bat 走卸载器 /S + vbs 设 FLOWZ_UNINSTALLER', () => {
    const un = 'C:\\Users\\张三\\FlowZ\\Uninstall FlowZ.exe';
    const { bat, vbs } = buildUninstallSidecar({ ...base, uninstaller: un, portableRmdir: false });
    expect(bat).toContain('if exist "%FLOWZ_UNINSTALLER%" "%FLOWZ_UNINSTALLER%" /S');
    expect(bat).not.toContain('FLOWZ_EXEDIR');
    expect(bat).not.toContain('FLOWZ_BODYTMP'); // 卸载器分支不 move 本体
    expect(bat).not.toContain('FLOWZ_EXE"'); // 不走 move exe 分支
    expect(vbs).toContain('e("FLOWZ_UNINSTALLER") = "C:\\Users\\张三\\FlowZ\\Uninstall FlowZ.exe"');
  });

  it('portable del（exeDir 非专属目录）：bat 仅 move exe（不 rmdir 目录，避免误删混放）+ vbs 设 FLOWZ_EXE/FLOWZ_BODYTMP', () => {
    const { bat, vbs } = buildUninstallSidecar({
      ...base,
      uninstaller: null,
      portableRmdir: false,
    });
    expect(bat).toContain('move /y "%FLOWZ_EXE%" "%FLOWZ_BODYTMP%" >nul 2>nul');
    expect(bat).not.toContain('FLOWZ_EXEDIR'); // 非专属目录不删整目录
    expect(vbs).toContain('e("FLOWZ_EXE") = "C:\\Users\\张三\\FlowZ\\FlowZ.exe"');
    expect(vbs).toContain(
      'e("FLOWZ_BODYTMP") = "C:\\Users\\张三\\AppData\\Local\\Temp\\flowz-uninstall-body-1234-99.exe"'
    );
    expect(vbs).not.toContain('FLOWZ_EXEDIR');
  });

  it('VBS 双引号路径转义（双写）', () => {
    const { vbs } = buildUninstallSidecar({
      ...base,
      userData: 'C:\\a"b\\flowz',
      uninstaller: null,
      portableRmdir: true,
    });
    expect(vbs).toContain('e("FLOWZ_USERDATA") = "C:\\a""b\\flowz"');
  });
});

describe('resolveUninstallBody', () => {
  // 便携态核心修复：app.getPath('exe') 是 %TEMP% 解压副本，须改取 PORTABLE_EXECUTABLE_FILE/DIR（用户原始本体）。
  it('便携态：优先取 PORTABLE_EXECUTABLE_FILE/DIR（原始本体），不用 %TEMP% 解压副本', () => {
    const realExe = 'C:\\Users\\张三\\AppData\\Local\\Temp\\FlowZ\\FlowZ.exe'; // app.getPath('exe')
    const r = resolveUninstallBody(
      {
        PORTABLE_EXECUTABLE_FILE: 'D:\\Downloads\\FlowZ-4.1.7-win-x64-portable.exe',
        PORTABLE_EXECUTABLE_DIR: 'D:\\Downloads',
      },
      realExe
    );
    expect(r.exePath).toBe('D:\\Downloads\\FlowZ-4.1.7-win-x64-portable.exe'); // 原始 exe，非 temp 副本
    expect(r.exeDir).toBe('D:\\Downloads');
  });

  it('便携专属目录：PORTABLE_EXECUTABLE_DIR 缺省时由原始 exe 取 win32 目录', () => {
    const r = resolveUninstallBody(
      { PORTABLE_EXECUTABLE_FILE: 'D:\\FlowZ\\FlowZ.exe' }, // 仅有 FILE，无 DIR
      'C:\\Temp\\FlowZ\\FlowZ.exe'
    );
    expect(r.exePath).toBe('D:\\FlowZ\\FlowZ.exe');
    expect(r.exeDir).toBe('D:\\FlowZ'); // path.win32.dirname，不受测试宿主（Linux）path 分隔符影响
  });

  it('NSIS 安装态（无 PORTABLE_* env）：回落 app.getPath(exe) 真实安装路径', () => {
    const realExe = 'C:\\Program Files\\FlowZ\\FlowZ.exe';
    const r = resolveUninstallBody({}, realExe);
    expect(r.exePath).toBe(realExe);
    expect(r.exeDir).toBe('C:\\Program Files\\FlowZ');
  });
});
