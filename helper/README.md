# FlowZ macOS 提权 helper

**简体中文** · [English](README.en.md)

macOS 下 TUN 模式需以 root 运行 sing-box。未签名应用无法用 `SMJobBless`/`SMAppService`，
默认每次启停 sing-box（含切节点重启）都会弹 `osascript` 管理员授权框。

本 helper 是一个 **root LaunchDaemon**（Go 静态二进制，无第三方依赖）：

- 用户**一次性**安装（osascript 授权一次），即注册为开机自启的 root 守护进程。
- app（普通用户）经 **token 鉴权的 unix socket** 驱动它启停 sing-box —— 之后**全程零授权框**。
- 未安装时自动回退到 PR-M1 的 root 看护脚本（osascript，启动一次授权，停止/退出/崩溃免授权）。

## 协议与安全

见 `helper.go` 顶部注释。要点：token 是主安全边界；sing-box 路径安装时锁定（`--singbox`）；
配置文件限制在 app 数据目录（`--confdir`）内。

## 构建

```bash
npm run build:helper          # 交叉编译 arm64 + x64 → resources/mac-*/com.flowz.helper
```

构建产物随 `electron-builder` 的 `extraResources`（`resources/mac-${arch}` → `mac`）打进 app 包，
运行时位于 `<App>/Contents/Resources/mac/com.flowz.helper`，安装时复制到
`/Library/PrivilegedHelperTools/com.flowz.helper`。
