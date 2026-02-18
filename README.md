# 🚀 FlowZ

> [!IMPORTANT]
> 本软件 Fork 自原作者项目：[zhangjh/FlowZ](https://github.com/zhangjh/FlowZ)  
> 如有需要可以关注 Telegram 频道获取更新: [https://t.me/flowzfork](https://t.me/flowzfork)

**简洁、现代、跨平台的代理客户端** —— 基于 **sing-box** 核心，支持 VLESS、Trojan、Shadowsocks 和 Hysteria2 协议。主打配置简单，规则明确，体验优良，所见即所得。

[![License](https://img.shields.io/github/license/zhangjh/FlowZ?color=blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/zhangjh/FlowZ?color=green)](../../releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)]()
[![Telegram](https://img.shields.io/badge/Telegram-Join%20Channel-blue?logo=telegram)](https://t.me/flowzfork)

> [!TIP]
> **开发初衷**：市面上许多代理软件规则配置过于复杂且难以生效。FlowZ 旨在提供一个规则清晰、所见即所得、且支持通配符自定义的纯净体验。

---

## ✨ 功能特性

* **全协议支持**：支持 **VLESS, Trojan, Hysteria2, Shadowsocks**。
* **路由规则系统**：内置强大的 **geosite/geoip** 规则集，支持通配符自定义域名规则。
* **TUN 透明代理**：支持 System/gVisor/Mixed 堆栈，全系统流量接管。
* **多种模式**：提供全局、智能、直连三种模式，自动处理流量。
* **现代化 UI**：基于 **shadcn/ui** 构建，支持亮色/暗色主题切换。
* **自动化体验**：支持开机自启动、自动连接及系统级代理自动接管。

---

## 🖼 界面预览

<p align="center">
  <img src="https://cdn.nodeimage.com/i/ns0xeUtvL7WUqXTcqpIoD9ucKL1oXiOl.webp" width="45%" />
  <img src="https://cdn.nodeimage.com/i/CqlzFHAJO0MoEyyoUhUIjDjY2Xl41tCi.webp" width="45%" />
</p>
<p align="center">
  <img src="https://cdn.nodeimage.com/i/Ob4dWzZrKM6yrLmUSxfAzvrnTyoTxxeR.webp" width="45%" />
  <img src="https://cdn.nodeimage.com/i/kxhVxYFpfgGH9XgGqypLBhMIC7kj2XTF.webp" width="45%" />
</p>

---

## 📋 系统要求

* **Windows**: 10 (1809+) 或 Windows 11
* **macOS**: 10.15+ (Catalina 或更高版本)

---

## 📥 安装

从 [Releases](../../releases) 页面下载最新版本：

* **Windows**: 运行 `.exe` 安装包。
* **macOS (Apple Silicon)**: 打开 `.dmg` 并拖入 Applications。
* **macOS (Intel)**: 需要从源码构建。

> [!CAUTION]
> 若 macOS 提示“软件已损坏”，请在终端执行：
> `xattr -cr /Applications/FlowZ.app`

---

## 🛠 从源码构建

```bash
# 克隆仓库
git clone [https://github.com/zhangjh/FlowZ.git](https://github.com/zhangjh/FlowZ.git)
cd FlowZ

# 安装依赖并运行
npm install
npm run dev

# 打包构建
npm run build
npm run package:win   # Windows
npm run package:mac   # macOS
