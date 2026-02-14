# FlowZ-本软件fork原软件大佬的地址https://github.com/zhangjh/FlowZ

简洁现代的跨平台代理客户端，基于 sing-box 核心，支持 VLESS、Trojan、Shadowsocks 协议和hysteria2协议（当前主流最安全好用的协议），主打配置简单，规则明确，体验优良所见即所得。


## ✨ 功能特性

- ✅ 支持 VLESS、Trojan、Hysteria2 以及 Shadowsocks 协议
- ✅ 强大的路由规则系统（geosite/geoip 规则集支持）
- ✅ 多种代理模式（全局、智能、直连）
- ✅ TUN 透明代理模式（支持 System/gVisor/Mixed 堆栈）
- ✅ 系统级代理设置自动接管
- ✅ 实时流量统计图表与速度测速
- ✅ 亮色/暗色主题切换
- ✅ 开机自启动和自动连接
- ✅ 现代化的用户界面（基于 Shadcn UI）
- ✅ 跨平台支持（Windows / macOS）
- 
<img src="https://cdn.nodeimage.com/i/ns0xeUtvL7WUqXTcqpIoD9ucKL1oXiOl.webp" alt="ns0xeUtvL7WUqXTcqpIoD9ucKL1oXiOl.webp">
<img src="https://cdn.nodeimage.com/i/CqlzFHAJO0MoEyyoUhUIjDjY2Xl41tCi.webp" alt="CqlzFHAJO0MoEyyoUhUIjDjY2Xl41tCi.webp">
<img src="https://cdn.nodeimage.com/i/xW3wXXCgxBBZ7hqV3HVpQSzFcB9gfv9l.webp" alt="xW3wXXCgxBBZ7hqV3HVpQSzFcB9gfv9l.webp">
<img src="https://cdn.nodeimage.com/i/kxhVxYFpfgGH9XgGqypLBhMIC7kj2XTF.webp" alt="kxhVxYFpfgGH9XgGqypLBhMIC7kj2XTF.webp">

## 📋 系统要求

- Windows 10 (1809+) 或 Windows 11
- macOS 10.15+ (Catalina 或更高版本)

## 📥 安装

从 [Releases](../../releases) 页面下载最新版本：

- Windows: 运行 `.exe` 安装包
- macOS (Apple Silicon): 打开 `.dmg` 文件并拖入 Applications
- macOS (Intel): 需要从源码构建，参见下方说明

## 🛠️ 从源码构建

```bash
# 克隆仓库
git clone https://github.com/zhangjh/FlowZ.git
cd FlowZ

# 安装依赖
npm install

# 开发模式运行
npm run dev

# 构建
npm run build

# 打包
npm run package:win   # Windows
npm run package:mac   # macOS
```

macOS Intel 用户需要修改 `electron-builder.json` 中的 `mac.target.arch` 为 `["x64"]`。

### mac下若打开提示“软件已损坏”，可在终端执行`xattr -cr /Applications/FLowZ.app`后再打开

## 🚀 快速开始

### 1. 配置服务器

- 打开应用 → "服务器"标签
- 选择协议（VLESS 或 Trojan）
- 填写服务器信息
- 点击"保存配置"

### 2. 连接代理

- 返回"首页"
- 点击"启用代理"
- 等待连接成功

### 3. 选择代理模式

默认是TUN模式，全部流量都被代理软件拦截，至于是否需要真正走代理软件请求，取决于选择的代理模式：

- **全局模式**：所有流量通过代理
- **智能模式**：自动分流（推荐）
- **直连模式**：不使用代理
  这种模式体验更佳，所有应用都可以实现代理，不需要手动配置，比如终端环境等。
  如果不希望使用TUN模式，可以进入设置页面手动选择"系统代理模式"。


### 4. 自定义规则

手动配置某些域名规则的代理模式：代理、直连、阻止，支持通配符方式。
这是促进我研发本项目的主要驱动力之一，市面上的一些代理软件在规则配置和执行方面要么太复杂，要么压根不生效。

## 🔧 技术栈

- Electron
- React 18 + TypeScript
- sing-box 核心
- Tailwind CSS + shadcn/ui

## 📄 开源协议

本项目采用 MIT 协议开源。

## 💬 反馈与支持

如遇到问题或有功能建议，请在 [Issues](../../issues) 页面提交。

## ⚠️ 免责声明

本软件仅供学习和研究使用，请遵守当地法律法规。使用本软件所产生的任何后果由使用者自行承担。


