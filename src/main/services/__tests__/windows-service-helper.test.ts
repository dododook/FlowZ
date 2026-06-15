/**
 * WindowsServiceHelper 纯逻辑单测（无 Windows 机/无命名管道）：
 *  - 平台门控：非 win32 安全降级（supported=false / ready=false），绝不触发 SCM/管道。
 *  - 提权脚本生成（runtime 最脆点）：sc create/start、binPath 锁定 exe+flags、token ACL、卸载脚本。
 *  - PowerShell 单引号转义。
 * 真机行为（UAC、sc 引号语义、管道连通）属 Windows 真机必验清单，不在单测范围。
 */
import { WindowsServiceHelper } from '../WindowsServiceHelper';
import { system32 } from '../../utils/win-system32';

// 「非 Windows 安全降级」只在非 Windows 宿主可测：helper 直接读 process.platform（无注入点），
// 在 Windows CI runner（win32）上该降级路径不可达 → 跳过；其逻辑由 macOS/Linux runner 覆盖。
const describeNonWin = process.platform === 'win32' ? describe.skip : describe;

describe('WindowsServiceHelper', () => {
  describeNonWin('非 Windows 平台安全降级', () => {
    // 测试宿主非 Windows（process.platform !== 'win32'）→ 所有方法降级，不连 SCM/管道。
    const helper = new WindowsServiceHelper();

    it('getStatus 返回 supported=false 的空状态', async () => {
      const s = await helper.getStatus();
      expect(s.supported).toBe(false);
      expect(s.installed).toBe(false);
      expect(s.ready).toBe(false);
      expect(s.needsRepair).toBe(false);
      expect(s.backgroundDisabled).toBe(false);
      expect(s.pathMismatch).toBe(false);
      expect(s.loaded).toBeNull();
    });

    it('isReady 返回 false（不尝试连接管道）', async () => {
      await expect(helper.isReady()).resolves.toBe(false);
    });

    it('install/uninstall 在非 Windows 报「仅 Windows 支持」', async () => {
      const i = await helper.install();
      expect(i.success).toBe(false);
      expect(i.error).toContain('Windows');
      const u = await helper.uninstall();
      expect(u.success).toBe(false);
      expect(u.error).toContain('Windows');
    });
  });

  describe('提权脚本生成', () => {
    const helper = new WindowsServiceHelper() as unknown as {
      buildInstallScript(exe: string, sb: string, conf: string, token: string): string;
      buildUninstallScript(): string;
      psq(s: string): string;
    };

    it('psq 转义单引号（PowerShell 双写规则）', () => {
      expect(helper.psq("a'b")).toBe("a''b");
      expect(helper.psq('plain')).toBe('plain');
    });

    it('install 脚本锁定 exe + flags、设 token ACL、sc create LocalSystem auto-start', () => {
      const script = helper.buildInstallScript(
        'C:\\Program Files\\FlowZ\\com.flowz.helper.exe',
        'C:\\Program Files\\FlowZ\\sing-box.exe',
        'C:\\Users\\doveh\\AppData\\Roaming\\FlowZ',
        'deadbeefdeadbeef'
      );
      // New-Service（非 sc create binPath=）：BinaryPathName 单一字符串直达 CreateService，绕开 CommandLineToArgvW 碎裂
      expect(script).toContain('New-Service -Name FlowZHelper -BinaryPathName $bp');
      expect(script).toContain('-StartupType Automatic');
      expect(script).not.toContain('binPath='); // 不得再用 sc create binPath= 的脆弱引号路径
      expect(script).not.toContain('-Credential'); // 锁定默认账户=LocalSystem 不变量（防误加凭据改成 NetworkService）
      // MED-1：sc delete 异步「标记删除」→ 轮询等服务消失 + New-Service 1072 退避重试
      expect(script).toContain('Get-Service');
      expect(script).toContain('1072');
      // 各含空格路径用**真双引号**包裹（非 \"），锁定 exe + 三参
      expect(script).toContain('--singbox "C:\\Program Files\\FlowZ\\sing-box.exe"');
      expect(script).toContain('--confdir "C:\\Users\\doveh\\AppData\\Roaming\\FlowZ"');
      expect(script).toContain('--support');
      // U1 外置：binPath 的引导 exe 必须指向 ProgramData 外置副本、而非 app 安装目录内的 helper.exe（根因修复——
      // 否则服务锁定 app 内文件 → 更新覆盖失败 + 卸载留孤儿）。slash 方向随测试宿主不同，故用 ProgramData 子串判定。
      expect(script).toMatch(/\$bp = '"[^']*ProgramData[^']*com\.flowz\.helper\.exe" --singbox/);
      // 反向不变量：binPath 引导 exe 绝不再是 app 的 Program Files 路径（防回归到「锁 app 内二进制」）。
      expect(script).not.toMatch(/\$bp = '"[^']*Program Files[^']*com\.flowz\.helper\.exe"/);
      // 复制源是 app 内置 helper.exe；目的是 ProgramData\FlowZ；带 -Force 覆盖 + 退避重试兜解锁窗口竞态。
      expect(script).toContain("$helperSrc = 'C:\\Program Files\\FlowZ\\com.flowz.helper.exe'");
      expect(script).toMatch(
        /\$helperDst = '[^']*ProgramData[^']*FlowZ[^']*com\.flowz\.helper\.exe'/
      );
      expect(script).toContain('Copy-Item -LiteralPath $helperSrc -Destination $helperDst -Force');
      expect(script).toContain('复制 helper.exe 到 ProgramData 失败'); // 复制失败 fail-loud（不静默留旧副本）
      // 目录 ACL 硬化（防本地提权 + 闭 token TOCTOU）：去继承 + 仅 SYSTEM/Administrators 完全控制并 (OI)(CI) 下传。
      // ProgramData 默认让 Users 能在子目录建/删文件 → 不锁目录则普通用户可替换以 SYSTEM 运行的 helper.exe（=提权）。
      // icacls 经 System32 绝对路径调（规避 PATH 缺失），PS 调用算子 & '<abs>'
      expect(script).toContain(`& '${system32('icacls.exe')}' $support /inheritance:r`);
      expect(script).toContain(
        `& '${system32('icacls.exe')}' $support /grant:r "SYSTEM:(OI)(CI)(F)" "Administrators:(OI)(CI)(F)"`
      );
      // 外置副本再显式收紧：去继承、仅 SYSTEM/Administrators 完全控制。
      expect(script).toContain(`& '${system32('icacls.exe')}' $helperDst /inheritance:r`);
      expect(script).toContain(
        `& '${system32('icacls.exe')}' $helperDst /grant:r "SYSTEM:(F)" "Administrators:(F)"`
      );
      // 关键不变量：SYSTEM helper 目录/二进制对 Users 零授权（绝不出现 Users 授权 → 杜绝替换/提权）。
      expect(script).not.toContain('Users:(RX)');
      expect(script).not.toContain('"Users');
      // 启动服务（sc.exe 经 System32 绝对路径调）
      expect(script).toContain(`& '${system32('sc.exe')}' start FlowZHelper`);
      // 幂等：重装先停删旧服务
      expect(script).toContain(`& '${system32('sc.exe')}' stop FlowZHelper`);
      expect(script).toContain(`& '${system32('sc.exe')}' delete FlowZHelper`);
      // token 值写入
      expect(script).toContain('deadbeefdeadbeef');
      // 重装可重入：写 token 前先删旧 token（自愈旧版「Admin 只读」残留——否则 Set-Content 覆盖只读文件被拒，真机根因）。
      expect(script).toContain('Remove-Item -Force -Path $tokenFile -ErrorAction SilentlyContinue');
      // 关键不变量：token **绝不**被设成 Admin 只读（机密性靠目录锁，不靠 token 只读；只读会破坏重装覆盖）。
      expect(script).not.toContain('icacls $tokenFile');
      expect(script).not.toContain('SYSTEM:(R)');
      // 删 token 必须在写 token 之前（顺序正确才自愈）。
      expect(script.indexOf('Remove-Item -Force -Path $tokenFile')).toBeLessThan(
        script.indexOf('Set-Content -Path $tokenFile')
      );
      // 受保护目录（默认 ProgramData\FlowZ）
      expect(script).toContain('FlowZ');
    });

    it('uninstall 脚本停 + 删服务 + 清受保护目录', () => {
      const script = helper.buildUninstallScript();
      expect(script).toContain(`& '${system32('sc.exe')}' stop FlowZHelper`);
      expect(script).toContain(`& '${system32('sc.exe')}' delete FlowZHelper`);
      expect(script).toContain('Remove-Item');
      expect(script).toContain('FlowZ');
    });
  });
});
