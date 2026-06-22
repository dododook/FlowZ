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
