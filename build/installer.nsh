; FlowZ 自定义 NSIS 卸载钩子（U4）：真卸载时清理「外置到 ProgramData 的提权 helper 服务」。
;
; 背景：helper.exe 在安装期被复制外置到 C:\ProgramData\FlowZ\com.flowz.helper.exe，并注册为 LocalSystem 服务
; FlowZHelper（binPath 指向外置副本，与 app 安装目录解耦——见 WindowsServiceHelper.buildInstallScript / U1）。
; NSIS 默认只删 app 安装目录文件，管不到 SCM 服务与 ProgramData → 不补此钩子会残留孤儿服务 + token。
;
; 三条卸载路径的处置：
;   1. app 更新（electron-builder 以 ${isUpdated} 跑旧版卸载器覆盖安装）→ **整体跳过**：外置 helper 与 app 解耦，
;      更新只换 app 文件、服务原样常驻；若此处动服务=每次更新断流 + 弹 UAC，正好违背外置初衷。
;   2. 用户经「设置/控制面板 → 添加或删除程序」直接卸载（app 未参与）→ 提权一次清服务 + 外置副本 + token。
;   3. app 内「卸载应用」（APP_UNINSTALL_ALL，U5）→ 先经命名管道零提权令 helper 自卸（自停删服务 + 删 ProgramData），
;      再唤起本卸载器 → 届时 sc query 命中「服务不存在」→ 跳过、**不弹第二次 UAC**。
;
; perMachine:false 的卸载器默认以普通用户运行（无提权），而 sc delete / 删 ProgramData 需管理员 → 经
; PowerShell Start-Process -Verb RunAs -Wait 提权一次完成（仅路径 2 真正触发 UAC）。best-effort：失败仅残留，
; 下次安装的幂等清理（buildInstallScript 停删旧服务）兜底。
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DetailPrint "检查 FlowZ 提权 helper 服务..."
    ; System32 绝对路径调系统命令（$SYSDIR=System32），不依赖 PATH——规避部分设备 PATH 缺失 System32
    ; 致命令未找到（与 src/main 的 win-system32 硬化同根）。nsExec 经 CreateProcess（搜索序含 System32）本较稳，
    ; 但 .ps1 内的 sc.exe 由 PowerShell 走 PATH 解析（见下），必须绝对路径化；此处一并收口、兼防 cwd 劫持。
    nsExec::ExecToStack '"$SYSDIR\sc.exe" query FlowZHelper'
    Pop $R4 ; 退出码：0=服务存在，1060=不存在
    Pop $R5 ; 输出（丢弃）
    ${If} $R4 == 0
      DetailPrint "清理 FlowZHelper 服务与 ProgramData（需一次管理员授权）..."
      InitPluginsDir
      ; 把清理命令写入临时 .ps1（避免多层引号嵌套）。$$ → 字面 $（令 $env:ProgramData 在提权 PS 内展开）。
      FileOpen $R6 "$PLUGINSDIR\flowz-helper-uninstall.ps1" w
      FileWrite $R6 `& "$SYSDIR\sc.exe" stop FlowZHelper$\r$\n`
      FileWrite $R6 `Start-Sleep -Milliseconds 500$\r$\n`
      FileWrite $R6 `& "$SYSDIR\sc.exe" delete FlowZHelper$\r$\n`
      FileWrite $R6 `Start-Sleep -Milliseconds 500$\r$\n`
      FileWrite $R6 `Remove-Item -Recurse -Force -Path "$$env:ProgramData\FlowZ" -ErrorAction SilentlyContinue$\r$\n`
      FileClose $R6
      ; 外层普通 PS 唤起内层提权 PS（-Verb RunAs 触发 UAC，-Wait 阻塞至清理完成，nsExec 再阻塞至外层结束）。
      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Start-Process '$SYSDIR\WindowsPowerShell\v1.0\powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','$PLUGINSDIR\flowz-helper-uninstall.ps1'"`
      Pop $R7 ; 退出码（丢弃；用户取消 UAC 时非 0，best-effort 不阻断卸载）
    ${EndIf}

    ; U6：真卸载清理用户数据（config/订阅/rule-resources/rules/logs/core_update/core-backup/core-version）。
    ; 背景：deleteAppDataOnUninstall:false + 旧钩子只清 ProgramData → 整个 %APPDATA%\flowz 无人删，
    ; 用户数据与「更新下载的内核（core_update）+ 核备份（core-backup）」全残留（控制面板卸载不净）。
    ; $APPDATA\flowz = app.getPath('userData')（Windows appName 小写 flowz）；roaming 属当前用户，
    ; perMachine:false 卸载器以普通用户身份即可删，无需 UAC（与上面 ProgramData/服务清理的提权路径解耦）。
    ; 仅真卸载执行（位于 ${ifNot} ${isUpdated} 块内）——app 更新走 isUpdated 分支、不会误删用户数据。
    DetailPrint "清理用户数据 $APPDATA\flowz ..."
    RMDir /r "$APPDATA\flowz"
  ${endif}
!macroend

; ================================================================
; #312 后续：已安装 + 手动双击 setup.exe 的 maintenance mode。
;
; 诉求：用户绕过 app 内更新器、手动双击新版 setup.exe 时（该路径无 --updated，
; ${isUpdated} 恒假），当前行为 = 显示目录页（可改路径，能装出第二个目录）+ 旧
; 卸载器跑 WinShell::UninstShortcut 取消任务栏固定（#312 在内置更新器修复后剩余
; 的唯一 pin 丢失面）。改为：已安装时首页给「升级 / 卸载」二选一。
;
;   升级 → 以 `--updated /currentuser` 重启自身 = 与内置更新器（fix #312 的
;          update-install-script.ts --updated）**同一链路**：skipPageIfUpdated
;          跳过目录页（= 锁死目录，杜绝第二个安装目录）、keep-shortcuts 链路保住
;          任务栏 pin、旧卸载器走 ${isUpdated} 分支跳过下方 customUnInstall
;          （helper 服务不断流、无 UAC、用户数据不动）。
;   卸载 → 启动已装的 Uninstall.exe（无 --updated = 真卸载语义：清 pin/helper
;          服务/用户数据，走下方 customUnInstall 的 ${ifNot} ${isUpdated} 块，
;          正确且与既有钩子零冲突）。
;
; 首装（检测不到已装）与内置更新器（--updated）两条路径均在 PRE 里 Abort → 零接触。
; 静默 /S 不带参数 + 页面回调 silent 下不执行 → 天然绕过。portable.nsi 无这些
; 插桩点 → 零影响。
;
; ---- mutex 竞态防护（升级分支 relaunch 的唯一工程难点）----
; ALLOW_ONLY_ONE_INSTALLER_INSTANCE（installer.nsi:73/76）在 .onInit 里建命名
; mutex（allowOnlyOneInstallerInstance.nsh:14），handle 用 `?e` 只压 GetLastError、
; 从未存储 → 无法主动释放，只能随进程退出由内核回收。升级分支的 relaunch 只能发生
; 在页面 Leave（用户点「升级」后），此时父实例 mutex 已持有 → 子实例直接 CreateMutex
; 会撞 ERROR_ALREADY_EXISTS 被 Abort（且父窗口已销毁，FindWindow 前台化也无效，
; 表现为「点了升级后再无任何窗口」）。
; 解法：relaunch 带 /flowz-wait-pid=<父PID>；子实例的 preInit（installer.nsi:56，
; **早于** :73 的 mutex 检查）里 WaitForSingleObject 等父进程退出（典型 <200ms，
; 上限 10s 兜底）→ 走到 mutex 检查时父 mutex 已回收 → 干净拿到。等的是「父句柄
; signaled」这个事实，非猜测时长；全程安装器自身代码，无 cmd/ping 外部进程链。
; 降级安全：参数缺失/PID 无效/OpenProcess 失败 → 跳过等待；超时 → 走原 mutex 检查
; （最坏 = 现状 Abort，不更劣）。
;
; System::Call 惯用法照模板：handle 用 `i` 类型接、`!= 0` 判定（getProcessInfo.nsh:118
; + allowOnlyOneInstallerInstance.nsh:57），非 `p`/`P<>`。
; ================================================================

; 仅 installer 编译单元声明：这 4 个 Var 只被 customInit/customWelcomePage 引用，而这两个宏
; 只在 !ifndef BUILD_UNINSTALLER 分支插入（installer.nsi）。electron-builder 把本文件同时 include
; 进 installer 与 uninstaller 两个编译单元；若顶层无条件声明，uninstaller 单元里它们声明却无处引用
; → makensis warning 6001「not referenced or never set」→ electron-builder `warning treated as error`
; → 打包失败。（preInit 用 $R0-$R2 通用寄存器、不碰这些 Var，两单元都插入亦无碍。）
!ifndef BUILD_UNINSTALLER
  Var flowzExistingDir   ; 已装 per-user 安装目录（"" = 未装 / 不启用 maintenance）
  Var flowzExistingVer   ; 已装版本号（仅 header 展示用）
  Var flowzRadioUpgrade  ; 「升级」单选控件句柄
  Var flowzRadioRemove   ; 「卸载」单选控件句柄
!endif

; 子实例侧：等待父安装器实例退出，规避 ALLOW_ONLY_ONE mutex 竞态。
; 此宏在 .onInit 的 mutex 检查之前展开（installer.nsi:56 < :73），是等待的唯一有效时机。
!macro preInit
  Push $R0
  Push $R1
  Push $R2
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/flowz-wait-pid=" $R1
  ${IfNot} ${Errors}
  ${AndIf} $R1 != ""
    ; OpenProcess(SYNCHRONIZE=0x00100000=1048576, bInheritHandle=0, pid) → handle（i 接，0=失败）
    System::Call 'kernel32::OpenProcess(i 1048576, i 0, i $R1) i .R2'
    ${If} $R2 != 0
      ; 父进程退出即 signaled，立即返回；父若卡死则 10s 上限兜底后继续（走原 mutex 检查）
      System::Call 'kernel32::WaitForSingleObject(i $R2, i 10000)'
      System::Call 'kernel32::CloseHandle(i $R2)'
    ${EndIf}
  ${EndIf}
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

; 检测本机已安装（在 initMultiUser + SetRegView 64 之后展开，installer.nsi:80）。
; 自读注册表，不依赖模板内部变量（$perUserInstallationFolder 等非稳定 API）。
!macro customInit
  ReadRegStr $flowzExistingDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $flowzExistingVer HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
  ; 闸门 1：存在 per-machine（HKLM）安装（历史 /allusers 装出）→ 不启用，回默认流程，不恶化现状
  ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R0 != ""
    StrCpy $flowzExistingDir ""
  ${EndIf}
  ; 闸门 2：注册表残留但主程序已不存在 → 当首装（避免对已删安装弹升级/卸载）
  ${If} $flowzExistingDir != ""
    ${IfNot} ${FileExists} "$flowzExistingDir\${APP_EXECUTABLE_FILENAME}"
      StrCpy $flowzExistingDir ""
    ${EndIf}
  ${EndIf}
!macroend

; 已安装时的首页「升级 / 卸载」。原生 Page custom（非 MUI_PAGE_CUSTOMFUNCTION define
; 机制）→ 与目录页的 skipPageIfUpdated PRE 槽零冲突。插在页序列第一位（assistedInstaller.nsh:9）。
!macro customWelcomePage
  Page custom flowzMaintenancePre flowzMaintenanceLeave

  Function flowzMaintenancePre
    ${If} ${isUpdated}             ; 内置更新器 / 我们自己的升级 relaunch：不介入
      Abort
    ${EndIf}
    ${If} $flowzExistingDir == ""  ; 未安装（或被闸门置空）：首装流程零改变
      Abort
    ${EndIf}

    ; 文案暂用英文字面量（PR 评审时如需随 $LANGUAGE 本地化再换 LangString）
    !insertmacro MUI_HEADER_TEXT "FlowZ $flowzExistingVer is already installed" "Choose an operation"
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateLabel} 0u 0u 300u 20u "Existing installation: $flowzExistingDir"
    Pop $0
    ${NSD_CreateRadioButton} 10u 34u 285u 12u "Upgrade to ${VERSION} (keeps settings and taskbar pin)"
    Pop $flowzRadioUpgrade
    ${NSD_CreateRadioButton} 10u 52u 285u 12u "Uninstall FlowZ"
    Pop $flowzRadioRemove
    ${NSD_Check} $flowzRadioUpgrade   ; 默认选「升级」
    nsDialogs::Show
  FunctionEnd

  Function flowzMaintenanceLeave
    ${NSD_GetState} $flowzRadioRemove $0
    ${If} $0 == ${BST_CHECKED}
      ; —— 卸载：启动已装卸载器。不传 --updated//S → 真卸载 GUI（走下方 customUnInstall
      ;    的 ${ifNot} ${isUpdated} 清理块）。Uninstall.exe 的 un.onInit 无 mutex 检查
      ;    （uninstaller.nsh），无竞态。
      ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
      ${If} $R0 != ""
        Exec '$R0'                  ; 值形如 "<dir>\Uninstall FlowZ.exe" /currentuser（已含引号）
      ${EndIf}
      SetErrorLevel 0
      Quit
    ${EndIf}
    ; —— 升级：以内置更新器同款参数重启自身。--updated → 跳目录页(锁死目录)+keep-shortcuts
    ;    (保 pin)+旧卸载器跳过 customUnInstall；/currentuser → 跳「为谁安装」页；
    ;    /flowz-wait-pid → 子实例 preInit 等本进程退出后再抢 mutex。
    System::Call 'kernel32::GetCurrentProcessId() i .r0'
    Exec '"$EXEPATH" /currentuser --updated /flowz-wait-pid=$0'
    SetErrorLevel 0
    Quit
  FunctionEnd
!macroend
