<div align="center">

<img src="docs/banner.png" width="100%" alt="FlowZ — a clean, modern cross-platform proxy client built on sing-box, WYSIWYG" />

[![release](https://img.shields.io/github/v/release/dododook/FlowZ?style=flat-square&color=0E98A4&label=release)](https://github.com/dododook/FlowZ/releases)
[![sing-box](https://img.shields.io/badge/sing--box-1.14-0E98A4?style=flat-square)](https://github.com/SagerNet/sing-box)
[![platform](https://img.shields.io/badge/platform-Windows%20·%20macOS%20·%20Linux-0E98A4?style=flat-square)](#-installation)
[![license](https://img.shields.io/badge/license-MIT-0E98A4?style=flat-square)](LICENSE.txt)
[![stars](https://img.shields.io/github/stars/dododook/FlowZ?style=flat-square&color=0E98A4)](https://github.com/dododook/FlowZ/stargazers)

[简体中文](README.md) · **English** · [繁體中文](README.zh-TW.md) · [Русский](README.ru.md) · [فارسی](README.fa.md)

</div>

> Original open-source project: https://github.com/zhangjh/FlowZ

Built around: **simple setup · clear rules · uninterrupted switching · authorize once, zero re-prompts**.

---

## 🌟 Highlights

- **Authorize once, never again** — a macOS root daemon / Windows system service is installed a single time; afterwards starting/stopping TUN, switching nodes, and quitting are all prompt-free.
- **Edit rules without dropping connections** — changing the match values of an already-enabled rule takes effect **instantly with zero interruption** via local rule-set hot-reload; only structural changes restart the core (debounced, restarted only once).
- **Any protocol, the core is the source of truth** — paste a sing-box outbound JSON and it just works; compatibility is probed against the running core on save. For protocols the official core doesn't support, you can **manually swap in a third-party fork core** — FlowZ detects the fork and disables online updates to protect it.
- **Mesh out of the box** — WireGuard / **WARP (one-click anonymous registration)** / **Tailscale (interactive browser login)** are first-class nodes you can select, route, and hot-switch.
- **No leftovers on exit** — cross-platform cleanup of the sing-box process / virtual adapter / system proxy, with fallbacks for crash, logout, and shutdown.
- **sing-box 1.14 native management** — bundled 1.14 core, native gRPC management API plus an optional official dashboard panel.

---

## ✨ Features

**Protocols**
- Proxy: VLESS / VMess / Trojan / Shadowsocks / **Snell** / Hysteria2 / TUIC / AnyTLS / **NaiveProxy** / SOCKS / HTTP / SSH
- Mesh: **WireGuard** / **Cloudflare WARP** / **Tailscale**
- **Custom protocol + core swap**: paste a sing-box outbound JSON; on save, "the core is the source of truth" probes live compatibility. For protocols the official core lacks, manually replace it with a third-party fork core that supports them (FlowZ auto-detects forks and disables online updates to avoid overwriting them).

**Core**
- sing-box 1.14 unified core, bundled per-platform (Windows / macOS arm64+x64 / Linux)
- Anti-censorship: **TLS Fragment** (global) / ECH / Multiplex / httpupgrade / **Shadow-TLS** (stackable on SS2022 and others) / **Hysteria2 port hopping** (auto-detected from subscriptions, some with manual toggles)
- **Block QUIC** (node-agnostic): reject proxy-bound QUIC/UDP 443 to force browsers back to TCP, fixing page stalls caused by nodes whose UDP relay is unreachable
- **WebRTC leak protection** (TUN only): off / via proxy / block

**Proxy modes & takeover**
- **TUN transparent proxy** + **system-proxy mode** + local-only proxy
- Route modes: Global / Smart (auto-split, recommended) / Direct
- **Seamless node hot-switch**: selector hot-switch, graceful by default with no dropped connections; optional "interrupt existing connections on switch"
- Proxy chains (upstream proxy)

**Mesh**
- WireGuard / WARP / Tailscale as endpoint nodes, treated exactly like ordinary proxies (selectable, routable, hot-switchable)
- **WARP one-click registration**: anonymous device registration, opportunistic de-registration on node deletion (no orphans)
- **Tailscale interactive login**: no authKey needed — click login, authorize in the browser; login state is verified and expiry is surfaced
- **Allow internet access** toggle: a mesh node can be an intranet-only peer or a full exit
- **Reverse mesh** (needs TUN + helper): act as a subnet router / be reachable from other devices on the mesh

**Routing rules**
- **Multi-condition rules**: domain / IP / port / process / geosite / geoip / rule-set and 15 condition types, combined with OR/AND
- **Rule-resource system**: built-in curated geosite/geoip lists + remote `.srs`/`.json` rule-set download and periodic updates
- **Editing rule values needs no restart**: changing the match values of an enabled rule (e.g. adding one domain) takes effect live via local rule-set hot-reload; structural changes (add/remove/reorder, change action) restart once (debounced)
- **App routing**: assign proxy / direct / block by process name or path
- List search + drag-and-drop ordering (top / bottom / move / keyboard a11y) + required note name + hover to expand the full rule

**DNS & splitting**
- **FakeIP** acceleration + region-based splitting (domestic-direct / reverse "back-home")
- **DNS takeover**: TUN mode takes over system DNS with crash-safe fallback
- DoH upstreams, node-domain anti-loopback, private DoH leak interception

**Subscriptions**
- Subscription import (sing-box JSON and common share formats)
- Manual import: bring nodes into Manual from a file or pasted text (sing-box / Xray / Clash configs, Base64, share links); Clash proxy-providers are imported as subscriptions (no auto-update, direct by default)
- Auto-update scheduling (**on by default**): catch-up for stale subscriptions on startup + periodic checks + exponential backoff + an "update over proxy" toggle; updates **never interrupt the current connection**
- Stable node fingerprint reconciliation: subscription updates keep local id / selected node, zero connection drop
- **GitHub mirror acceleration**: core / rule resources / dashboard downloads can route through a gh-proxy mirror

**UI & experience**
- **Conduit design system**: token-driven dual theme (light / dark) + self-hosted fonts
- Five languages: Simplified Chinese / Traditional Chinese / English / Русский / فارسی (with RTL)
- Connection topology · live traffic stats & speed tests · exit-IP display
- **Privacy mode** (password lock; scrypt hash stored in a separate file, not in config)
- **Auto-idle mode** (real system input idle triggers lightweight / privacy mode)
- **macOS menu-bar resident**: closing the window hides it from the Dock, leaving only the menu bar; reopen from the menu bar / Spotlight
- Launch on boot + auto-connect + silent start

**Management & diagnostics**
- **sing-box 1.14 native gRPC management API** (replacing clash_api): status / connections / groups / node hot-switch all go through the native plane
- **Official sing-box dashboard integration** (opt-in escape hatch): when enabled, the core serves the official panel at `/dashboard/` for power users
- **Diagnostic report export**: one-click redacted diagnostic collection for troubleshooting

**System & reliability**
- **Zero-prompt privilege chain**: macOS root daemon · Windows LocalSystem service + named pipe / socket · token auth
- **No leftovers on exit**: cross-platform cleanup of processes / virtual adapters / system-proxy registry, with crash / logout / shutdown fallbacks
- Auto-update: integrity verification + startup pre-check + automatic rollback on failure + skip known-bad versions
- Cross-platform: Windows / macOS (Apple Silicon + Intel) / Linux

---

## 🖼 Screenshots

> Screenshots use built-in demo data, not real subscriptions / nodes. The UI shown is the Chinese build; layout is identical across languages.

### Home · Connection overview
WYSIWYG connection status, node switching, live rates and connection topology. Light / dark dual theme:

| Light | Dark |
|:---:|:---:|
| <img src="docs/screenshots/home-light.webp" width="100%"> | <img src="docs/screenshots/home-dark.webp" width="100%"> |

### Nodes & subscriptions
One-click subscription import, node-card management, protocol badges, batch speed tests and ordering:

<img src="docs/screenshots/servers.webp" width="100%">

### App routing · Routing rules
Assign proxy / direct / block per app; rules support multi-condition combinations (domain / IP / port / process / geosite and 15 types, OR/AND) + drag ordering + zero-restart value edits:

| App routing | Routing rules |
|:---:|:---:|
| <img src="docs/screenshots/app-routing.webp" width="100%"> | <img src="docs/screenshots/rules.webp" width="100%"> |

### Rule resources
Built-in curated geosite/geoip lists + remote `.srs` rule-set download and periodic updates:

<img src="docs/screenshots/rule-resources.webp" width="100%">

### Connection diagnostics · Live logs
Per-connection rate / rule hit / node chain; leveled live logs:

| Connections | Logs |
|:---:|:---:|
| <img src="docs/screenshots/connections.webp" width="100%"> | <img src="docs/screenshots/logs.webp" width="100%"> |

### Settings · Authorize once, zero re-prompts
Fine-grained settings; **after installing the privilege helper / service once, starting/stopping TUN needs no further authorization** (one UAC on Windows / one password on macOS):

<img src="docs/screenshots/settings.webp" width="100%">

---

## ⚠️ Known Limitations & Behavior Notes

Please read this before opening an issue — the following are **by design, not bugs**.

### A brief reconnect (~1s) on structural config changes is expected
The underlying sing-box core has **no API to add/remove an outbound or reload its full config at runtime** (its Clash-compatible API only switches among already-loaded nodes; `PUT /configs` is a no-op). FlowZ therefore splits changes into two classes:

- **Live, zero-interruption** — connections never drop:
  - Switching the selected node (selector hot-switch).
  - Editing the *match values* of an already-enabled rule (e.g. adding a domain to its list) — applied via local rule-set hot-reload.
- **~1s core restart** (debounced; multiple quick edits are coalesced into one, connections drop briefly then resume automatically):
  - Adding / removing / reordering rules, or changing a rule's action / target.
  - Switching route mode (Global / Smart / Direct), changing local ports or TUN/inbound settings.
  - Editing a node that is currently referenced, or a subscription update that introduces **new referenced nodes**.

This restart is fast and connections come back on their own. **Please don't file issues about a brief blip when changing these settings** — it is inherent to how sing-box applies structural changes.

### Other expected behaviors
- **Tailscale: one node per device.** All Tailscale accounts share `100.64.0.0/10`; multiple Tailscale nodes would overwrite each other.
- **NaiveProxy needs the Cronet library** on Linux/Windows (fetched at build time). If it's missing, naive nodes are auto-skipped — other protocols are unaffected; if a selected node is naive you'll get an explicit notice.
- **System-proxy mode can't fully control DNS or block QUIC leaks.** Only TUN mode takes over system DNS and can reject proxy-bound QUIC. Use TUN if you need leak-proof DNS / QUIC.
- **Block QUIC affects proxy-bound QUIC only.** Nodes that dial over QUIC (hysteria2 / tuic / naive) are unaffected — it rejects UDP 443 destined for the proxy to push browsers back to TCP.
- **macOS "FlowZ is damaged"** on an unsigned build → clear the quarantine attribute: `xattr -cr /Applications/FlowZ.app`.

---

## 📋 System Requirements

| Platform | Requirement |
|------|------|
| Windows | Windows 10 (1809+) / Windows 11, x64 |
| macOS | macOS 11 (Big Sur)+, Apple Silicon or Intel |
| Linux | x86_64, AppImage / `.deb` (TUN mode needs a one-time `pkexec` setcap authorization) |

---

## 📥 Installation

Download the latest build from [Releases](https://github.com/dododook/FlowZ/releases).

| Platform | Install |
|------|------|
| **Windows** | Run the `.exe` installer, or the portable `portable.exe` |
| **macOS** | Open the `.dmg` and drag to Applications; arm64 / Intel are both published (naive works out of the box on Intel) |
| **Linux** | Run the `AppImage` directly, or install the `.deb` |

If macOS reports "FlowZ is damaged", clear the quarantine attribute:

```bash
xattr -cr /Applications/FlowZ.app
```

---

## 🚀 Quick Start

1. **Add a node** — pick a protocol on the "Servers" page, use "Manual Import" to bring in nodes from a file or text (sing-box / Xray / Clash / Base64 / share links), or import a subscription link under "Subscriptions".
2. **Pick a mode** — choose a route mode on the home page (default: Smart / auto-split); if you don't want TUN, switch to "system-proxy mode" in Settings.
3. **Enable the proxy** — click "Enable proxy" on the home page.
4. **(Optional) Configure rules** — add custom rules / referenced rule-sets under "Routing rules"; assign per-app policy under "App routing".

---

## 🛠 Build from Source

```bash
git clone https://github.com/dododook/FlowZ.git
cd FlowZ
npm install

npm run dev            # development (Vite + Electron hot reload)
npm run build          # compile main process + renderer

npm run package:win    # Windows installer + portable
npm run package:mac    # macOS (arm64 + x64, incl. cross-compiled root helper)
npm run package:linux  # Linux (AppImage + deb)
```

- `package:mac` / `package:win` run `build:helper` first (Go cross-compile of the privilege helper) before packaging.
- NaiveProxy's Cronet library is fetched at packaging time by `npm run fetch:cronet` (see "NaiveProxy notes" below).

---

## 🛡 Advanced Notes

### Seamless node switching
**Selector hot-switch** by default: switching nodes doesn't restart the core, existing connections live until they close naturally, and new connections use the new node (graceful, no drops). The "**interrupt existing connections on switch**" advanced option (off by default) forces a disconnect/rebuild. **Editing the match values of an enabled rule** takes effect with zero restart via local rule-set hot-reload; cross-mode / port / TUN / structural rule changes (add/remove/reorder/change action) trigger a restart (multiple edits debounced into one).

### Mesh
WireGuard / WARP / Tailscale join as endpoint nodes and behave like ordinary proxies — selectable, rule-targetable, hot-switchable.

- **WARP**: one-click anonymous registration; pure exit node, add several as backup / failover (one active at a time).
- **Tailscale**: account-based, click "login" for browser authorization (authKey also supported); **only one Tailscale node per device** — all accounts share `100.64.0.0/10`, multiple would overwrite each other.
- **Allow internet access**: on = full exit; off = intranet-only.
- **Reverse mesh** (needs TUN + helper): create a real kernel interface so this machine is reachable from other mesh devices / acts as a subnet router; off by default (userspace is egress-only, zero privilege).

### Block QUIC (advanced)
Rejects **proxy-bound QUIC (UDP 443)** to push browsers back to TCP, fixing "page stalls / drops caused by unreachable node UDP relay". **Node-agnostic**; nodes that dial over QUIC themselves (hysteria2 / tuic / naive) are **not affected**. Off by default.

### Anti-censorship
- **TLS Fragment** (global toggle): splits the TLS ClientHello to evade SNI-based DPI blocking. Applies to all TCP-TLS nodes; hysteria2 / tuic / naive are auto-excluded.
- **ECH / Multiplex / httpupgrade / Hysteria2 port hopping**: **auto-detected from the sing-box JSON subscription** (Multiplex auto-skipped for reality+vision nodes; port hopping supports multiple ranges).

### Official sing-box dashboard (opt-in)
When enabled in Settings, the core serves the official sing-box panel at `/dashboard/` on the management API port. **Available only while the proxy is running**, independent of proxy / route mode. The panel assets are downloaded on first use (can route through the GitHub mirror).

### ⚠️ NaiveProxy (naive) core library
naive's outbound uses **Chromium's Cronet network library** for browser-identical fingerprints; linking differs per platform:
- **Linux / Windows**: Cronet is a **dynamic library** (`libcronet.so` / `libcronet.dll`), fetched from [SagerNet/cronet-go](https://github.com/SagerNet/cronet-go/releases) by `npm run fetch:cronet` and bundled into the installer (large; not committed, fetched at build time).
- **macOS (arm64 and x64)**: Cronet is **statically linked** into the sing-box core (CGO); naive **works out of the box, no external library**.

> On platforms/architectures lacking Cronet, naive nodes are **auto-skipped** (other protocols unaffected; you'll get a clear notice if the selected node is naive).

---

## 🔧 Tech Stack

- **Electron 42** + **React 19** + TypeScript
- **sing-box 1.14** (proxy core, bundled per-platform)
- Management: sing-box 1.14 **native gRPC API** (replacing clash_api)
- Tailwind CSS + Radix UI · **Conduit design system** (token-driven dual theme + self-hosted fonts)
- Vite (build) / electron-builder (packaging)
- Go (macOS privilege helper · Windows privilege service)

---

## 📄 License

MIT License

---

## ⚠️ Disclaimer

This software is for learning and research only. Comply with your local laws and regulations. You bear all consequences of using this software.

---

## ⭐ Star History

[![Star History Chart](https://star-history.dera.page/svg?repos=dododook/FlowZ&type=Date)](https://star-history.dera.page/#dododook/FlowZ&Date)
