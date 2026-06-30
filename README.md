<div align="center">

<img src="docs/banner.png" width="100%" alt="FlowZ — 简洁现代的跨平台代理客户端，基于 sing-box，所见即所得" />

[![release](https://img.shields.io/github/v/release/dododook/FlowZ?style=flat-square&color=0E98A4&label=release)](https://github.com/dododook/FlowZ/releases)
[![sing-box](https://img.shields.io/badge/sing--box-1.14-0E98A4?style=flat-square)](https://github.com/SagerNet/sing-box)
[![platform](https://img.shields.io/badge/platform-Windows%20·%20macOS%20·%20Linux-0E98A4?style=flat-square)](#-安装)
[![license](https://img.shields.io/badge/license-MIT-0E98A4?style=flat-square)](LICENSE.txt)
[![stars](https://img.shields.io/github/stars/dododook/FlowZ?style=flat-square&color=0E98A4)](https://github.com/dododook/FlowZ/stargazers)

**简体中文** · [English](README.en.md) · [繁體中文](README.zh-TW.md) · [Русский](README.ru.md) · [فارسی](README.fa.md)

</div>

> 原作者开源地址：https://github.com/zhangjh/FlowZ

主打：**配置简单 · 规则明确 · 切换不断流 · 一次授权零提权**。

---

## 🌟 核心亮点

- **一次授权，永久零提权** — macOS root daemon / Windows 系统服务，装一次后 TUN 启停 · 切节点 · 退出全程免授权。
- **改规则不断流** — 编辑已启用规则的匹配值经 local rule-set 热重载**即时生效、连接零中断**；只有结构变更才重启（去抖合并、只重启一次）。
- **任意协议，内核即权威** — 粘贴 sing-box outbound JSON（如 **Snell**）即用，保存时实时探测当前内核兼容性；官方核不支持的协议可**手动换用第三方 fork 内核**，FlowZ 自动识别 fork 并停用在线更新以保护它。
- **组网开箱即用** — WireGuard / **WARP（一键匿名注册）** / **Tailscale（浏览器交互登录）** 作为一等节点，可选中 · 分流 · 热切。
- **退出零残留** — 跨平台清理 sing-box 进程 / 虚拟网卡 / 系统代理，崩溃 · 注销 · 关机都兜底。
- **sing-box 1.14 原生管理面** — 内置 1.14 内核，原生 gRPC 管理 API + 可选官方 dashboard 面板。

---

## ✨ 功能特性

**协议**
- 代理：VLESS / VMess / Trojan / Shadowsocks / Hysteria2 / TUIC / AnyTLS / **NaiveProxy** / SOCKS / HTTP / SSH
- 组网：**WireGuard** / **Cloudflare WARP** / **Tailscale**
- **自定义协议 + 换核扩展**：粘贴 sing-box outbound JSON（如 **Snell**），保存时「内核即权威」实时探测兼容性；官方核不支持的协议可手动替换为支持它的第三方 fork 内核（FlowZ 自动识别 fork、停用在线更新以防覆盖）

**核心**
- sing-box 1.14 统一内核，随包内置（Windows / macOS arm64+x64 / Linux）
- 抗封增强：**TLS Fragment**（全局）/ ECH / Multiplex / httpupgrade / **Shadow-TLS**（可附加于 SS2022 等协议）/ **Hysteria2 端口跳跃**（订阅自动识别，部分附手动开关）
- **Block QUIC**（节点无关）：reject 代理向 QUIC/UDP 443，逼浏览器回退 TCP，解决节点 UDP relay 不通导致的网页卡顿
- **WebRTC 防泄露**（仅 TUN）：off / 走代理 / 阻断，三档可选

**代理模式与接管**
- **TUN 透明代理** + **系统代理模式** + 仅本地代理
- 路由模式：全局 / 智能（自动分流，推荐）/ 直连
- **无缝热切换节点**：selector 热切，默认优雅不断流；可选「切换时中断现有连接」
- 代理链（前置代理）

**组网 / Mesh**
- WireGuard / WARP / Tailscale 作为 endpoint 节点，与普通代理一视同仁（可选中、可分流、可热切）
- **WARP 一键注册**：匿名注册设备即用，删除节点时机会式注销、不留孤儿
- **Tailscale 交互登录**：无需 authKey，点登录走浏览器授权，登录态求真、过期自动提示
- **允许访问外网**开关：组网节点既可只通内网、也可当全量出口
- **反向 mesh**（需 TUN + helper）：本机作子网路由 / 被组网内其它设备访问

**路由规则**
- **单条规则多条件组合**：域名 / IP / 端口 / 进程 / geosite / geoip / 规则集 等 15 类，OR/AND 组合
- **规则资源体系**：内置 geosite/geoip 精选清单 + 远程 `.srs`/`.json` 规则集下载与定期更新
- **改规则值零重启**：编辑已启用规则的匹配值（如往域名清单加一条）经 local rule-set 热重载即时生效、连接不中断；增删 / 排序 / 改策略等结构变更才重启（去抖合并，连改多条只重启一次）
- **应用分流**：按进程名 / 路径指定 代理 / 直连 / 阻止
- 列表搜索 + 拖拽排序（置顶 / 置底 / 上下移 / 键盘无障碍）+ 必填备注名 + 悬浮展开完整规则

**DNS 与分流**
- **FakeIP** 加速 + 按地区分流（国内直连 / 回国反向）
- **DNS 接管**：TUN 模式接管系统 DNS，崩溃安全兜底
- DoH 上游、节点域名防回流、隐私 DoH 泄漏拦截

**订阅**
- 订阅链接导入（sing-box JSON 与常见分享格式）
- 手动导入：从文件或粘贴文本（sing-box / Xray / Clash 配置、Base64、分享链接）批量导入到自建节点；Clash proxy-providers 同时导入为订阅（默认不自动更新、直连）
- 自动更新调度（**默认开启**）：启动补更陈旧订阅 + 周期巡检 + 失败指数退避 + 「经代理更新」开关，更新**不打断当前连接**
- 节点稳定指纹对账：订阅更新保留本地 id / 选中节点，连接零中断
- **GitHub 镜像加速**：内核 / 规则资源 / 面板等 GitHub 下载可走 gh-proxy 镜像

**界面与体验**
- **Conduit 设计系统**：token 驱动双主题（亮 / 暗）+ 自托管字体，视觉统一
- 五语言：简体中文 / 繁體中文 / English / Русский / فارسی（含 RTL）
- 连接拓扑 · 实时流量统计与测速 · 出口 IP 展示
- **隐私保护模式**（密码锁，scrypt 哈希存独立文件、不入配置）
- **自动空闲模式**（系统真实输入空闲触发轻量 / 隐私模式）
- **macOS 菜单栏常驻**：关窗即从程序坞隐去、仅留菜单栏，点菜单栏 / Spotlight 唤回
- 开机自启 + 自动连接 + 静默启动

**管理与诊断**
- **sing-box 1.14 原生 gRPC 管理 API**（取代 clash_api）：状态 / 连接 / 分组 / 节点热切统一走原生面
- **官方 sing-box 面板集成**（opt-in 逃生舱）：开关开启后由内核在 `/dashboard/` serve 官方面板，给高级用户全功能入口
- **诊断报告导出**：一键采集脱敏诊断信息，便于排障

**系统与可靠性**
- **零授权提权链**：macOS root daemon · Windows LocalSystem 服务 + 命名管道 / socket · token 鉴权
- **退出零残留**：跨平台清理进程 / 虚拟网卡 / 系统代理注册表，崩溃 · 注销 · 关机兜底
- 自动更新：完整性校验 + 启动预检 + 失败自动回滚 + 问题版本跳过
- 跨平台：Windows / macOS（Apple Silicon + Intel）/ Linux

---

## 🖼 界面预览

> 截图为内置 demo 数据，非真实订阅 / 节点。各语言界面布局一致。

### 首页 · 连接总览
所见即所得的连接状态、节点切换、实时速率与连接拓扑。亮 / 暗双主题：

| 浅色主题 | 深色主题 |
|:---:|:---:|
| <img src="docs/screenshots/home-light.webp" width="100%"> | <img src="docs/screenshots/home-dark.webp" width="100%"> |

### 节点与订阅
订阅一键导入、节点卡片管理、协议标识、批量测速与排序：

<img src="docs/screenshots/servers.webp" width="100%">

### 应用分流 · 路由规则
按应用一键指定 代理 / 直连 / 阻止；规则支持多条件组合（域名 / IP / 端口 / 进程 / geosite 等 15 类，OR/AND）+ 拖拽排序 + 改值零重启：

| 应用分流 | 路由规则 |
|:---:|:---:|
| <img src="docs/screenshots/app-routing.webp" width="100%"> | <img src="docs/screenshots/rules.webp" width="100%"> |

### 规则资源
内置 geosite/geoip 精选清单 + 远程 `.srs` 规则集下载与定期更新：

<img src="docs/screenshots/rule-resources.webp" width="100%">

### 连接诊断 · 实时日志
逐连接速率 / 规则命中 / 节点链；分级实时日志：

| 连接信息 | 实时日志 |
|:---:|:---:|
| <img src="docs/screenshots/connections.webp" width="100%"> | <img src="docs/screenshots/logs.webp" width="100%"> |

### 设置 · 一次授权零提权
精细设置；**装一次提权 helper / 服务后，TUN 模式启停免每次授权**（Windows 一次 UAC / macOS 一次密码）：

<img src="docs/screenshots/settings.webp" width="100%">

---

## ⚠️ 已知限制与行为说明

提 issue 前请先读——以下均为**设计如此，并非 bug**。

### 结构性配置变更会短暂重连（约 1 秒），属正常
底层 sing-box 内核**没有运行时增删 outbound / 重载整份配置的 API**（其 Clash 兼容 API 只能在已加载节点间切换，`PUT /configs` 是空操作）。因此 FlowZ 把变更分为两类：

- **实时生效、连接零中断**：
  - 切换选中节点（selector 热切换）。
  - 编辑已启用规则的**匹配值**（如往域名清单加一条）——经 local rule-set 热重载。
- **约 1 秒内核重启**（去抖：连续多次编辑合并为一次；连接短暂中断后自动恢复）：
  - 增 / 删 / 排序规则，或改规则的动作 / 目标。
  - 切换路由模式（全局 / 智能 / 直连）、改本地端口或 TUN/inbound 设置。
  - 编辑当前被引用的节点，或订阅更新引入了**被引用的新节点**。

重启很快、连接会自动恢复。**改这些设置时出现短暂闪断请勿提 issue**——这是 sing-box 应用结构性变更的固有方式。

### 其它预期行为
- **Tailscale：每设备只支持一个节点。** 所有 Tailscale 账号共用 `100.64.0.0/10`，多个会互相覆盖。
- **NaiveProxy 依赖 Cronet 库**（Linux/Windows，打包时拉取）。缺失时 naive 节点会被**自动跳过**——其它协议不受影响；若选中的正是 naive 节点会明确提示。
- **系统代理模式无法完整控制 DNS、也挡不住 QUIC 泄漏。** 只有 TUN 模式接管系统 DNS 并能 reject 代理向 QUIC。需要防泄漏的 DNS/QUIC 请用 TUN。
- **Block QUIC 仅作用于代理向 QUIC。** 以 QUIC 拨号的节点（hysteria2 / tuic / naive）自身不受影响——它 reject 的是去往代理的 UDP 443，逼浏览器回退 TCP。
- **macOS 提示「软件已损坏」**（未签名构建）→ 移除隔离属性：`xattr -cr /Applications/FlowZ.app`。

---

## 📋 系统要求

| 平台 | 要求 |
|------|------|
| Windows | Windows 10（1809+）/ Windows 11，x64 |
| macOS | macOS 11 (Big Sur)+，Apple Silicon 或 Intel |
| Linux | x86_64，AppImage / `.deb`（TUN 模式需 `pkexec` 一次性授权 setcap） |

---

## 📥 安装

从 [Releases](https://github.com/dododook/FlowZ/releases) 下载最新版本。

| 平台 | 安装 |
|------|------|
| **Windows** | 运行 `.exe` 安装包，或免安装 `portable.exe` |
| **macOS** | 打开 `.dmg` 拖入「应用程序」；arm64 / Intel 均随发布提供（Intel 版 naive 开箱即用） |
| **Linux** | `AppImage` 直接运行，或安装 `.deb` |

macOS 若提示「软件已损坏」，移除隔离属性即可：

```bash
xattr -cr /Applications/FlowZ.app
```

---

## 🚀 快速开始

1. **添加节点** —「服务器」页选协议填信息，用「手动导入」从文件/文本（sing-box·Xray·Clash·Base64·分享链接）批量导入，或在「订阅」导入订阅链接。
2. **选模式** — 首页选路由模式（默认 智能 / 自动分流）；不用 TUN 可在设置切「系统代理模式」。
3. **启用代理** — 首页点「启用代理」。
4. **（可选）配规则** —「路由规则」加自定义规则 / 引用规则集；「应用分流」按应用指定策略。

---

## 🛠 从源码构建

```bash
git clone https://github.com/dododook/FlowZ.git
cd FlowZ
npm install

npm run dev            # 开发（Vite + Electron 热重载）
npm run build          # 编译主进程 + 渲染端

npm run package:win    # Windows 安装包 + 便携版
npm run package:mac    # macOS（arm64 + x64，含交叉编译 root helper）
npm run package:linux  # Linux（AppImage + deb）
```

- `package:mac` / `package:win` 会先 `build:helper`（Go 交叉编译提权 helper），再打包。
- NaiveProxy 的 cronet 库由 `npm run fetch:cronet` 在打包时拉取（见下「NaiveProxy 说明」）。

---

## 🛡 进阶说明

### 无缝切换节点
默认 **selector 热切换**：切节点不重启内核、现有连接保留至自然关闭、新连接走新节点（优雅不断流）。高级设置「**切换时中断现有连接**」（默认关）开启后强制断开重建。**编辑已启用规则的匹配值**经 local rule-set 热重载零重启生效；跨模式 / 端口 / TUN / 规则结构（增删 / 排序 / 改策略）等改动才重启（多次改动去抖合并、只重启一次）。

### 组网 / Mesh
WireGuard / WARP / Tailscale 作为 endpoint 节点接入，和普通代理一样可选中、可被规则指向、可热切。

- **WARP**：一键匿名注册即用；纯出口节点，可加多个作备选 / failover（一次激活一个）。
- **Tailscale**：账号制，点「登录」走浏览器授权（也支持 authKey）；同一设备**只支持一个 Tailscale 节点**——所有账号共用 `100.64.0.0/10` 网段，多个会互相覆盖。
- **允许访问外网**：开 = 当全量出口；关 = 只通组网内网段。
- **反向 mesh**（需 TUN + helper）：建真内核接口，让本机可被组网内其它设备访问 / 作子网路由；默认关（用户态只出不进，零提权）。

### Block QUIC（高级设置）
对**代理向 QUIC（UDP 443）**执行 reject、逼浏览器回退 TCP，解决「节点 UDP relay 不通导致网页卡顿 / 断流」。**节点无关**；hysteria2 / tuic / naive 等以 QUIC 拨号的节点**自身拨号不受影响**。默认关。

### 抗封增强
- **TLS Fragment**（全局开关）：切分 TLS ClientHello，规避基于 SNI 的 DPI 阻断。对所有 TCP-TLS 节点生效；hysteria2 / tuic / naive 自动排除。
- **ECH / Multiplex / httpupgrade / Hysteria2 端口跳跃**：从 **sing-box JSON 订阅自动识别并生效**（Multiplex 对 reality+vision 节点自动跳过；端口跳跃支持多段范围）。

### sing-box 官方面板（opt-in）
设置开启后，内核会在管理 API 监听口的 `/dashboard/` 提供官方 sing-box 面板。**仅在代理运行时可用**，与代理模式 / 路由模式无关。首次需联网下载面板资源（可走 GitHub 镜像加速）。

### ⚠️ NaiveProxy（naive）核心库说明
naive 出站底层走 **Chromium 的 Cronet 网络库**以获得与浏览器一致的指纹，各平台链接方式不同：
- **Linux / Windows**：cronet 走**动态库**（`libcronet.so` / `libcronet.dll`），由 `npm run fetch:cronet` 从 [SagerNet/cronet-go](https://github.com/SagerNet/cronet-go/releases) 拉取并随安装包打入（体积大，不入库、打包时拉取）。
- **macOS（arm64 与 x64）**：cronet 由 sing-box 内核**静态编入**（CGO），naive **开箱即用、无需外部库**。

> 缺少 cronet 的平台 / 架构上，naive 节点会被**自动跳过**（不影响其它协议；若选中的正是 naive 节点会明确提示）。

---

## 🔧 技术栈

- **Electron 42** + **React 19** + TypeScript
- **sing-box 1.14**（代理内核，多平台随包内置）
- 管理面：sing-box 1.14 **原生 gRPC API**（取代 clash_api）
- Tailwind CSS + Radix UI · **Conduit 设计系统**（token 驱动双主题 + 自托管字体）
- Vite（构建）/ electron-builder（打包）
- Go（macOS 提权 helper · Windows 提权服务）

---

## 📄 开源协议

MIT License

---

## ⚠️ 免责声明

本软件仅供学习与研究使用。请遵守当地法律法规。使用本软件所产生的任何后果由使用者自行承担。

---

## ⭐ Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=dododook/FlowZ&type=Date)](https://star-history.com/#dododook/FlowZ&Date)
