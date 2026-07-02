#!/usr/bin/env bash
# 交叉编译 FlowZ 提权 helper（Go）：macOS（helper/，纯 stdlib，两 mac 架构）+ Windows（helper-win/，winio+x-sys，amd64）
# + Linux（helper-linux/，纯 stdlib，宿主架构）。
# 产物随 electron-builder extraResources（resources/mac-${arch} → mac；resources/win；resources/linux → linux）打进 app 包。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/helper"
OUT_NAME="com.flowz.helper"

if ! command -v go >/dev/null 2>&1; then
  if [ -n "${REQUIRE_HELPER:-}" ]; then
    echo "[build-helper] REQUIRE_HELPER 已设但未找到 go 工具链 —— 提权 helper 是发布必需组件，终止以避免静默发布无 helper 的包" >&2
    exit 1
  fi
  echo "[build-helper] 未找到 go 工具链，跳过 helper 构建（提权 helper 不打包，运行时回退 osascript 看护脚本；发布构建经 setup-go 保证可用）" >&2
  exit 0
fi

build() {
  local arch="$1" goarch="$2"
  local out="$ROOT/resources/mac-$arch/$OUT_NAME"
  echo "[build-helper] mac-$arch ($goarch) → $out"
  ( cd "$SRC" && GOOS=darwin GOARCH="$goarch" CGO_ENABLED=0 \
      go build -trimpath -ldflags="-s -w" -o "$out" . )
  chmod 755 "$out"
}

build arm64 arm64
build x64 amd64

# Windows 提权服务 helper（独立 module helper-win/，含 vendor/ → -mod=vendor 离线构建）。
# 输出到 resources/win/（与 sing-box.exe / libcronet.dll 同目录，对齐 ResourceManager.getWinHelperPath 与
# getPlatformResourceDir 的 win 分支）。GOOS=windows 从任意宿主交叉编译（纯 Go + winio/x-sys，CGO 关）。
WIN_SRC="$ROOT/helper-win"
if [ -d "$WIN_SRC" ]; then
  WIN_OUT="$ROOT/resources/win/com.flowz.helper.exe"
  echo "[build-helper] win-x64 (amd64) → $WIN_OUT"
  mkdir -p "$ROOT/resources/win"
  ( cd "$WIN_SRC" && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
      go build -mod=vendor -trimpath -ldflags="-s -w" -o "$WIN_OUT" . )
fi

# Linux 提权 helper（独立 module helper-linux/，纯 stdlib，需 linux-only syscall → 只在 GOOS=linux 编译）。输出到
# resources/linux/（与 sing-box / libcronet.so 同目录，对齐 ResourceManager.getLinuxHelperPath 与 getPlatformResourceDir
# 的 linux 分支；electron-builder 打包 resources/linux → linux）。按宿主架构本地编译；跨架构（arm64）随对应架构的发布
# 构建另行 GOARCH=arm64 交叉编译（AmbientCaps/SO_PEERCRED 为 linux 通用，无 CGO）。
LINUX_SRC="$ROOT/helper-linux"
if [ -d "$LINUX_SRC" ]; then
  LINUX_OUT="$ROOT/resources/linux/flowz-helper-linux"
  # 钉 amd64 匹配 package:linux/dist:linux 的 electron-builder --x64（否则 arm64 主机构建会打进不可执行的二进制）。
  # 纯 Go + linux-only syscall、无 CGO → 交叉编译零依赖；将来出 arm64 发布另加 GOARCH=arm64 腿即可。
  LINUX_GOARCH="${LINUX_GOARCH:-amd64}"
  echo "[build-helper] linux ($LINUX_GOARCH) → $LINUX_OUT"
  mkdir -p "$ROOT/resources/linux"
  ( cd "$LINUX_SRC" && GOOS=linux GOARCH="$LINUX_GOARCH" CGO_ENABLED=0 \
      go build -trimpath -ldflags="-s -w" -o "$LINUX_OUT" . )
  chmod 755 "$LINUX_OUT"
fi
echo "[build-helper] done"
