/**
 * macOS 提权 helper IPC 处理器
 * 状态查询 + 安装/卸载（安装/卸载会弹一次 osascript 管理员授权框）。
 */

import { BrowserWindow, IpcMainInvokeEvent, app, shell, dialog } from 'electron';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { HelperStatus } from '../../../shared/types';
import { system32 } from '../../utils/win-system32';
import { registerIpcHandler } from '../ipc-handler';
import type { IPrivilegedHelper } from '../../services/IPrivilegedHelper';
import type { IProxyManager } from '../../services/ProxyManager';
import { getSingboxDashboardDir } from '../../utils/paths';
import { mapElectronLocaleToDashboardLang } from '../../utils/dashboard-locale';
import { mt } from '../../i18n';

/**
 * 清 sing-box 官方面板资源缓存目录（dashboard.path）。删后核下次启动因目录为空 → 从 download_url 重拉新 zip。
 * 改 singboxDashboardUrl（saveConfig 检测）或「刷新面板资源」IPC 调此。recursive+force：不存在不报错。
 */
export function clearSingboxDashboardCache(): void {
  try {
    fs.rmSync(getSingboxDashboardDir(), { recursive: true, force: true });
  } catch {
    // 删缓存失败不致命：核启动若目录仍非空只是沿用旧资源，下次仍可重试清理。
  }
}

// sing-box 官方面板内窗口单例（dashboard #55）：再次「打开面板」时聚焦复用而非重复开窗；closed 时置 null。
let dashboardWindow: BrowserWindow | null = null;

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

  // 打开 sing-box 官方面板（dashboard #55）：开**应用内 BrowserWindow** 加载运行期 /dashboard/（核 serve 内置/覆盖面板处），
  // 并经面板专用 preload 在 document-start 预写 localStorage `sing-box-dashboard.server`（一键直连，免手填后端）。
  // 真机实证：面板只读该 localStorage 键、不读 URL 参数，故 payload 必须经 preload 在面板 JS 读 localStorage 前写好。
  // 代理未运行（端口=0）→ 不打开（dashboard 仅运行中可用）；UI 侧亦在「开关 on 且运行中」才 enable 按钮。
  registerIpcHandler<string | undefined, { ok: boolean }>(
    IPC_CHANNELS.OPEN_SINGBOX_DASHBOARD,
    async (_event, locale) => {
      const info = proxyManager.getDashboardConnectionInfo();
      if (!info.ok) return { ok: false };

      // 已有面板窗口 → 聚焦复用（避免重复开窗）。
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.focus();
        return { ok: true };
      }

      // 预写面板 localStorage（面板源码实证 index-*.js）：
      //  - 权威存储键 `sing-box-dashboard.servers`：{servers:[{id,name,url,secret}],activeId}（面板渲染/连接的实际数据源）。
      //  - 旧版迁移键 `sing-box-dashboard.server`：扁平 {url,secret}（面板读一次即 removeItem 并并入 servers 存储）——兜底
      //    极旧版面板。url 用 host:port（无协议前缀），与面板 g() 归一化（去尾斜杠 + 去 http:// 前缀）后存量格式一致。
      const serverId = crypto.randomUUID();
      const bareUrl = info.apiUrl.replace(/^https?:\/\//, '');
      // 面板语言：优先用渲染端传入的 UI 语言（i18n.language），映射到面板合法码（源码实证 xl=[en/zh-Hans/zh-Hant/fa/ru]），preload 首开写入。
      // app.getLocale() 仅作兜底——它返回 Electron app bundle locale（FlowZ.app 未声明 zh → 恒 en），与 FlowZ UI 实际语言脱钩，
      // 单用它会让中文 UI 的内窗口面板仍显英文。映射逻辑同面板 El()，前缀匹配可正确处理 zh-CN/zh-TW/fa-IR 等。
      const dashLang = mapElectronLocaleToDashboardLang(locale || app.getLocale());
      const serverPayload = JSON.stringify({
        servers: {
          servers: [{ id: serverId, name: '', url: bareUrl, secret: info.secret }],
          activeId: serverId,
        },
        legacy: { url: bareUrl, secret: info.secret },
        language: dashLang,
      });

      dashboardWindow = new BrowserWindow({
        width: 1100,
        height: 760,
        minWidth: 800,
        minHeight: 600,
        title: 'sing-box Dashboard',
        autoHideMenuBar: true,
        webPreferences: {
          // 面板专用 preload：经 additionalArguments 拿 server payload，在页面脚本前于同源写 localStorage。
          // dashboard-preload.ts 在 src/main/ 顶层（rootDir=src/outDir=dist/main）→ 编到 dist/main/main/dashboard-preload.js。
          // 锚 app.getAppPath()（dev=项目根、打包=app.asar 根）+ 固定相对路径，比从本文件 __dirname 上跳目录稳——
          // 后者随本 handler 文件迁移层级即失配（曾因上跳级数不符解析到不存在路径 → preload 静默不加载 → localStorage
          // 未预写 → 面板空表单，dashboard #55 自动连真机回归根因）。
          preload: path.join(app.getAppPath(), 'dist/main/main/dashboard-preload.js'),
          // 本窗口仅加载本地 127.0.0.1 受信面板，关 contextIsolation 让 preload 直写页面同源 localStorage；零 Node 暴露（preload 不挂 API）。
          contextIsolation: false,
          nodeIntegration: false,
          sandbox: false,
          additionalArguments: [`--flowz-dashboard-server=${serverPayload}`],
        },
      });
      if (process.platform !== 'darwin') dashboardWindow.setMenu(null);
      dashboardWindow.once('closed', () => {
        dashboardWindow = null;
      });

      // 安全闸（H1）：本窗口 contextIsolation 关 + 加载第三方面板代码，必须锁死导航边界——否则面板内任意链接/重定向/
      // window.open 可把本窗口（或继承同 webPreferences 的子窗口）导航到远端源，泄漏已写入 localStorage 的 secret。
      //  - setWindowOpenHandler：拒绝一切子窗口；http(s) 外链改走系统浏览器（绝不在带这套 prefs 的窗口里开）。
      //  - will-navigate：只允许停留在本地 api service 源（http://127.0.0.1:<port>），跨源导航一律拦下。
      const localOrigin = info.apiUrl; // http://127.0.0.1:<port>（无尾斜杠）
      const wc = dashboardWindow.webContents;
      wc.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
        return { action: 'deny' };
      });
      wc.on('will-navigate', (event, url) => {
        if (!url.startsWith(`${localOrigin}/`)) {
          event.preventDefault();
          if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
        }
      });

      await dashboardWindow.loadURL(info.url);
      return { ok: true };
    }
  );

  // 刷新 sing-box 官方面板资源：清本地缓存目录 → 核下次启动（或下次配置变更触发 switchMode 重启）重拉新 zip。
  // 不在此触发重启（保「不打断连接」语义）：UI 提示用户重连/下次启动生效。删目录幂等，不存在不报错。
  registerIpcHandler<void, { ok: boolean }>(IPC_CHANNELS.REFRESH_SINGBOX_DASHBOARD, async () => {
    clearSingboxDashboardCache();
    return { ok: true };
  });

  // dashboard #55：取面板连接信息（url=面板 URL + apiUrl + secret）供「复制连接信息」按钮与面板 URL 显示。
  // url 字段不可漏：渲染端 singbox-dashboard-section 据 info.url 显示可点的面板地址，缺失则恒回落「未运行」文案。
  registerIpcHandler<void, { ok: boolean; url: string; apiUrl: string; secret: string }>(
    IPC_CHANNELS.GET_SINGBOX_DASHBOARD_CONNECTION,
    async () => {
      const info = proxyManager.getDashboardConnectionInfo();
      return { ok: info.ok, url: info.url, apiUrl: info.apiUrl, secret: info.secret };
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
          } else if (process.platform === 'linux') {
            // Linux 删应用本体（原仅删 userData、漏删本体 → 卸载后应用仍在）。官方 target 仅 AppImage + deb：
            //   AppImage → $APPIMAGE 是原始 .AppImage（exe 是 /tmp FUSE 挂载点、非文件本身）；deb → /opt/FlowZ root 拥有、app 无写权。
            // 能安全删的目标（AppImage 原文件 / 用户可写的 flowz 专属目录）**只移废纸篓**——刻意不 rmSync 强删：
            //   无废纸篓后端（精简 WM）时 trashItem reject，若回退 rm -rf 整个父目录会永久误删用户混放文件，无回收网。
            // 删不掉（deb root 无权 / 无 trash 后端 / 边缘形态）→ 弹原生 dialog 引导手动移除，附**实际路径** + deb 包管理器命令
            //   （数据已清；toast 会随 app 退出丢失，故用阻塞 dialog，不静默假装成功）。
            try {
              const exeDir = path.dirname(app.getPath('exe'));
              const appImage = process.env.APPIMAGE;
              let target: string | null = null;
              if (appImage && fs.existsSync(appImage)) {
                target = appImage;
              } else if (
                /flowz/i.test(path.basename(exeDir)) &&
                exeDir.startsWith(os.homedir() + path.sep)
              ) {
                // exe 父目录是「家目录下」的 flowz 专属目录（AppImage extract / 手动解压）且可写才程序删。
                // **限定家目录**：deb 装的 /opt·/usr 即使被 sudo 跑/改权限弄成可写也绝不程序删——那会绕过 dpkg
                // 致包库不一致 + /usr 下 .desktop 悬空，故系统目录一律 target=null 走 dialog 引导经 apt 卸载。
                try {
                  fs.accessSync(exeDir, fs.constants.W_OK);
                  target = exeDir;
                } catch {
                  /* 无写权 → 走手动引导 */
                }
              }
              let removed = false;
              if (target) {
                // 仅移废纸篓（可恢复安全网）；失败不强删，转手动提示
                removed = await shell
                  .trashItem(target)
                  .then(() => true)
                  .catch(() => false);
              }
              if (!removed) {
                const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
                const opts = {
                  type: 'info' as const,
                  title: mt('uninstallManualTitle'),
                  message: mt('uninstallManualMessage'),
                  detail: `${mt('uninstallManualBody')}\n\n${target ?? exeDir}`,
                  buttons: [mt('uninstallManualOk')],
                };
                if (win) await dialog.showMessageBox(win, opts);
                else await dialog.showMessageBox(opts);
              }
            } catch {
              /* 删本体失败不阻断退出 */
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
