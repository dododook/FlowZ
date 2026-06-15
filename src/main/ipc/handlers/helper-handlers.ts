/**
 * macOS 提权 helper IPC 处理器
 * 状态查询 + 安装/卸载（安装/卸载会弹一次 osascript 管理员授权框）。
 */

import { IpcMainInvokeEvent, app, shell } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { HelperStatus } from '../../../shared/types';
import { system32 } from '../../utils/win-system32';
import { registerIpcHandler } from '../ipc-handler';
import type { IPrivilegedHelper } from '../../services/IPrivilegedHelper';
import type { IProxyManager } from '../../services/ProxyManager';

export function registerHelperHandlers(
  helperManager: IPrivilegedHelper,
  proxyManager: IProxyManager
): void {
  registerIpcHandler<boolean | undefined, HelperStatus>(
    IPC_CHANNELS.HELPER_GET_STATUS,
    async (_event, force) => helperManager.getStatus(force === true)
  );

  registerIpcHandler<void, { success: boolean; error?: string; status: HelperStatus }>(
    IPC_CHANNELS.HELPER_INSTALL,
    async (_event: IpcMainInvokeEvent) => helperManager.install()
  );

  registerIpcHandler<void, { success: boolean; error?: string; status: HelperStatus }>(
    IPC_CHANNELS.HELPER_UNINSTALL,
    async (_event: IpcMainInvokeEvent) => {
      // 卸载前若代理正经 helper 运行：先用「仍在的 helper」零提权停核，再卸载。否则卸载后 helper socket
      // 消失，下次 stop 会落 forceKill 裸弹 osascript（无引导）。卸载本身的 osascript 授权是预期的一次。
      if (proxyManager.getStatus().running && proxyManager.isStartedViaHelper()) {
        await proxyManager.stop().catch(() => {});
      }
      return helperManager.uninstall();
    }
  );

  // 完全卸载 FlowZ：清 helper + 受保护目录（root，弹一次密码框）+ 用户配置 + 应用本体（移废纸篓），然后退出。
  registerIpcHandler<void, { ok: boolean; error?: string }>(
    IPC_CHANNELS.APP_UNINSTALL_ALL,
    async () => {
      try {
        // 停代理（在位 helper 零提权停核，避免卸载后裸弹 osascript）
        if (proxyManager.getStatus().running && proxyManager.isStartedViaHelper()) {
          await proxyManager.stop().catch(() => {});
        }
        // 1. 清 helper + 其受保护资源。
        //    macOS：uninstall 脚本 rm -rf /Library/Application Support/FlowZ（含受保护目录 core/），弹一次密码框。
        //    Windows：helper.uninstall 走命名管道零提权令服务自停删 + 删 ProgramData\FlowZ（含外置 helper.exe + token）；
        //      仅在 helper 确已安装时执行——未装则跳过，避免提权兜底路径无谓弹 UAC。
        if (process.platform === 'darwin') {
          const r = await helperManager.uninstall();
          if (!r.success) {
            return { ok: false, error: r.error || 'helper 卸载失败，已中止完全卸载' };
          }
        } else if (process.platform === 'win32') {
          const st = await helperManager.getStatus();
          if (st.installed) {
            const r = await helperManager.uninstall();
            if (!r.success) {
              return { ok: false, error: r.error || 'helper 卸载失败，已中止完全卸载' };
            }
          }
        }
        // 2. 删用户数据 + 应用本体。
        //    非 win32（darwin/linux）：用户目录可写、进程内直接 rmSync userData（恢复 Linux 原行为）；mac 额外把 .app 移废纸篓。
        //    win32：userData 与 exe 都被本进程占用，进程内 rmSync 删不掉 → 交给分离 sidecar，等本进程退出后再清。
        if (process.platform !== 'win32') {
          try {
            fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
          } catch {
            /* 尽力清理 */
          }
          if (process.platform === 'darwin') {
            try {
              const appBundle = app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]+$/, '');
              if (appBundle.endsWith('.app')) {
                await shell.trashItem(appBundle);
              }
            } catch {
              /* 删不掉 .app 不阻断退出 */
            }
          }
        } else {
          // 分离 sidecar .bat：精确轮询本进程 PID 退出（不受同名 FlowZ.exe 残留干扰）→ 删 userData → 静默唤起 NSIS
          // 卸载器（无则 rmdir 安装目录）→ 自删。进程内删不掉的根因：app 持有 userData 句柄 + exe 自身被占用；
          // 必须 quit 让出占用后再由独立进程清。PID 轮询 + 60s 上限，避免 imagename 误判同名进程导致无限卡死。
          // 卸载器 /S 静默（用户已在应用内确认完全卸载）；helper 已在第 1 步零提权卸掉 → customUnInstall 钩子 sc query
          // 落空 → 不二次弹 UAC。portable 无卸载器时 rmdir 安装目录（best-effort：装 Program Files 时普通用户无权删，残留由下次安装幂等清理兜底）。
          try {
            const exePath = app.getPath('exe');
            const exeDir = path.dirname(exePath);
            const userData = app.getPath('userData');
            const flowzPid = process.pid;
            let uninstaller = path.join(exeDir, 'Uninstall FlowZ.exe');
            if (!fs.existsSync(uninstaller)) {
              const hit = fs.readdirSync(exeDir).find((f) => /^Uninstall FlowZ.*\.exe$/i.test(f));
              if (hit) uninstaller = path.join(exeDir, hit);
            }
            const hasUninstaller = fs.existsSync(uninstaller);
            // portable 无卸载器：目录名含 FlowZ（专属目录）才 rmdir 整目录，否则只删 exe 自身
            // （避免误删用户自选的非专属目录如 D:\Tools\，portable 仍可恢复）。
            const portableCleanup = exeDir.toLowerCase().includes('flowz')
              ? `rmdir /s /q "${exeDir}"`
              : `del /f /q "${exePath}"`;
            const stamp = Date.now();
            const batPath = path.join(os.tmpdir(), `flowz-uninstall-${flowzPid}-${stamp}.bat`);
            const vbsPath = path.join(os.tmpdir(), `flowz-uninstall-${flowzPid}-${stamp}.vbs`);
            // CRLF 行尾 + GBK 安全（纯 ASCII，路径走变量不内联中文）。
            const lines = [
              '@echo off',
              `set "FLOWZ_PID=${flowzPid}"`,
              'set "WAIT=0"',
              ':wait',
              // 精确等本进程 PID 退出；60×~1s=60s 上限防卡死。
              `"${system32('tasklist.exe')}" /fi "PID eq %FLOWZ_PID%" 2>nul | "${system32('find.exe')}" "%FLOWZ_PID%" >nul || goto clean`,
              'set /a WAIT+=1',
              'if %WAIT% GEQ 60 goto clean',
              `"${system32('ping.exe')}" 127.0.0.1 -n 2 >nul`,
              'goto wait',
              ':clean',
              `rmdir /s /q "${userData}"`,
              hasUninstaller ? `if exist "${uninstaller}" "${uninstaller}" /S` : portableCleanup,
              `del /f /q "${vbsPath}"`, // 清隐藏启动器自身
              'del "%~f0"',
              '',
            ];
            fs.writeFileSync(batPath, lines.join('\r\n'), 'utf8');
            // VBScript 隐藏启动器：WScript.Shell.Run(cmd, 0, False) 以隐藏窗口(0)、不等待(False)拉起 .bat。
            // 规避 Node `spawn('cmd', {detached:true, windowsHide:true})` 在 Windows 上仍弹出 cmd 控制台窗口的已知坑
            // （detached 新建进程组与 windowsHide 冲突 → 卸载残留终端窗口需手动关闭）。wscript //B 无 UI 随即退出，
            // 其 .Run 出的 cmd/bat 成为独立后台进程、全程无终端窗口；bat 收尾删 .vbs + 自删。
            // VBS 字符串内 "" 即字面量 "，故 `cmd /c "<bat>"` 正确加引号容纳带空格路径。
            const vbs = `Set s = CreateObject("WScript.Shell")\r\ns.Run """${system32('cmd.exe')}"" /c ""${batPath}""", 0, False\r\n`;
            fs.writeFileSync(vbsPath, vbs, 'utf8');
            spawn(system32('wscript.exe'), ['//B', '//Nologo', vbsPath], {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
              cwd: os.tmpdir(),
            }).unref();
          } catch {
            /* 唤起 sidecar 失败不阻断退出（用户仍可经「添加或删除程序」卸载，含同款 helper 清理钩子） */
          }
        }
        // 4. 退出（留 0.5s 让 IPC 回执先到达渲染端）
        setTimeout(() => app.quit(), 500);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );
}
