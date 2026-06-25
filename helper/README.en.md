# FlowZ macOS privilege helper

[简体中文](README.md) · **English**

On macOS, TUN mode requires sing-box to run as root. An unsigned app can't use `SMJobBless` / `SMAppService`, so by default every sing-box start/stop (including the restart on a node switch) pops an `osascript` admin-authorization dialog.

This helper is a **root LaunchDaemon** (a static Go binary, no third-party deps):

- The user installs it **once** (a single `osascript` authorization), registering it as a root daemon that starts on boot.
- The app (a normal user) drives sing-box start/stop over a **token-authenticated unix socket** — **no further dialogs after that**.
- When not installed, it falls back to the PR-M1 root guardian script (`osascript`: one authorization on start; stop / quit / crash need none).

## Protocol & security

See the comment block at the top of `helper.go`. Key points: the token is the primary security boundary; the sing-box path is locked at install time (`--singbox`); config files are confined to the app data directory (`--confdir`).

## Build

```bash
npm run build:helper          # cross-compile arm64 + x64 → resources/mac-*/com.flowz.helper
```

The output is bundled into the app via electron-builder `extraResources` (`resources/mac-${arch}` → `mac`), lives at runtime under `<App>/Contents/Resources/mac/com.flowz.helper`, and is copied to `/Library/PrivilegedHelperTools/com.flowz.helper` on install.
