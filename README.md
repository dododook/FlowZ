# FlowZ

本软件 fork 自原作者项目：  
https://github.com/zhangjh/FlowZ  

如有需要可关注：  
https://t.me/flowzfork  

---

简洁现代的跨平台代理客户端，基于 sing-box 核心。  
支持 VLESS、Trojan、Shadowsocks、Hysteria2 协议。  

主打：

- 配置简单
- 规则明确
- 所见即所得
- 稳定好用

---

## ✨ 功能特性

- ✅ 支持 VLESS、Trojan、Hysteria2、Shadowsocks协议。
- ✅ 强大的路由规则系统（支持 geosite / geoip 规则集）
- ✅ 多种代理模式（全局 / 智能 / 直连）
- ✅ TUN 透明代理模式（支持 System / gVisor / Mixed 堆栈）
- ✅ 系统级代理自动接管
- ✅ 实时流量统计与测速
- ✅ 支持前置代理，完美实现代理链功能
- ✅ 亮色 / 暗色主题切换
- ✅ 开机自启动与自动连接
- ✅ 现代化 UI（基于 shadcn/ui）
- ✅ 跨平台支持（Windows / macOS）

---

## 🖼 界面预览

<img src="https://cdn.nodeimage.com/i/ns0xeUtvL7WUqXTcqpIoD9ucKL1oXiOl.webp">
<img src="https://cdn.nodeimage.com/i/CqlzFHAJO0MoEyyoUhUIjDjY2Xl41tCi.webp">
<img src="https://cdn.nodeimage.com/i/Ob4dWzZrKM6yrLmUSxfAzvrnTyoTxxeR.webp">
<img src="https://cdn.nodeimage.com/i/kxhVxYFpfgGH9XgGqypLBhMIC7kj2XTF.webp">

---

## 📋 系统要求

- Windows 10 (1809+) 或 Windows 11
- macOS 10.15+（Catalina 或更高版本）

---

## 📥 安装

从 Releases 页面下载最新版本。

### Windows
运行 `.exe` 安装包

### macOS (Apple Silicon)
打开 `.dmg` 并拖入 Applications

### macOS (Intel)
需要从源码构建

若 macOS 提示“软件已损坏”：

```bash
xattr -cr /Applications/FlowZ.app
```

---

## 🛠 从源码构建

```bash
git clone https://github.com/zhangjh/FlowZ.git
cd FlowZ

npm install
npm run dev
npm run build
npm run package:win
npm run package:mac
```

macOS Intel 用户需要修改 `electron-builder.json`：

```json
"arch": ["x64"]
```

---

## 🚀 快速开始

### 1. 配置服务器

- 打开应用 → 服务器标签
- 选择协议
- 填写服务器信息
- 保存配置

### 2. 启用代理

- 返回首页
- 点击“启用代理”

### 3. 选择代理模式

默认使用 TUN 模式。

可选模式：

- 全局模式：所有流量走代理
- 智能模式：自动分流（推荐）
- 直连模式：不使用代理

如不希望使用 TUN，可在设置中切换为“系统代理模式”。

---

## 🔧 技术栈

- Electron
- React 18 + TypeScript
- sing-box
- Tailwind CSS
- shadcn/ui

---

## 📄 开源协议

MIT License

---

## ⚠️ 免责声明

本软件仅供学习与研究使用。  
请遵守当地法律法规。  
使用本软件所产生的任何后果由使用者自行承担。

---

## ⭐ Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=dododook/FlowZ&type=Date)](https://star-history.com/#dododook/FlowZ&Date)