# 资源文件目录

**简体中文** · [English](README.en.md)

这个目录包含应用程序的跨平台资源文件。

## 目录结构

```
resources/
├── win/                          # Windows (x64)
│   ├── sing-box.exe              # sing-box 可执行文件（fetch 产物，不入库）
│   ├── libcronet.dll             # NaïveProxy/cronet 运行时库（dlopen，fetch 产物，不入库）
│   └── com.flowz.helper.exe      # 提权服务 helper（build 产物，不入库）
├── linux/                        # Linux (x64)
│   ├── sing-box                  # sing-box 可执行文件（fetch 产物，不入库）
│   └── libcronet.so              # NaïveProxy/cronet 运行时库（dlopen，fetch 产物，不入库）
├── mac-x64/                      # macOS Intel (x64)
│   ├── sing-box                  # sing-box 可执行文件（fetch 产物，不入库）
│   └── com.flowz.helper          # 提权服务 helper（build 产物，不入库）
├── mac-arm64/                    # macOS Apple Silicon (arm64)
│   ├── sing-box                  # sing-box 可执行文件（fetch 产物，不入库）
│   ├── com.flowz.helper          # 提权服务 helper（build 产物，不入库）
│   └── LICENSE
├── dashboard/                    # sing-box 官方面板静态资源（fetch 产物，不入库）
├── data/                         # 共享数据：随包内置 geo 规则集（geoip-*.srs / geosite-*.srs，入库）
├── app.png / app-gray.png        # 托盘图标（常态/置灰）
├── README.md                     # 本文档（简体中文）
└── README.en.md                  # English
```

> 说明：`data/` geo 规则集、图标与 `LICENSE` **入库**；`sing-box` 二进制、`libcronet.*`、`dashboard/`、
> `com.flowz.helper{,.exe}` 体积大或属构建产物 **不入库**，由下列命令在开发/CI 现拉现编后随 `resources/` 一起打包：
>
> - `npm run fetch:core`     → 各平台 `sing-box[.exe]`（SagerNet 官方 release，按 core-manifest.json 的 `bundledCoreVersion` 拉、`coreArchiveSha256` 校验压缩包）
> - `npm run fetch:cronet`   → 各平台 `libcronet.*`（NaïveProxy/cronet，运行时 dlopen）
> - `npm run fetch:dashboard`→ `dashboard/`（官方面板，gh-pages 构建产物）
> - `npm run build:helper`   → 各平台 `com.flowz.helper{,.exe}`（提权服务，交叉编译）
>
> 应用图标本体见 `build/icon.ico` / `build/icon.icns`（electron-builder 打包用）；`resources/app*.png` 仅作托盘图标。

## 资源管理

应用程序使用 `ResourceManager` 类来管理资源文件的访问：

- 自动检测当前平台和架构（win / linux / mac-x64 / mac-arm64）
- 处理开发环境和生产环境的路径差异
- 提供统一的资源访问接口

## 开发环境 vs 生产环境

- **开发环境**：从项目根目录的 `resources/` 加载。
- **生产环境**：从打包后的 `resources/`（electron-builder `extraResources`）加载。

## 注意事项

1. **可执行权限**：macOS / Linux 的 `sing-box` 与 helper 需可执行权限（`chmod +x`）。
2. **文件大小**：`sing-box` 可执行文件较大（约 65–77 MB/平台），会影响安装包大小；故不入库、由 `npm run fetch:core` 现拉现打（见文首说明与下「换核」）。
3. **更新**：GeoIP/GeoSite 数据（`data/*.srs`）需定期更新以获得最新路由规则；运行期亦可经规则资源管理在线更新到 userData。
4. **换核**：改 `src/shared/core-manifest.json` 的 `bundledCoreVersion` + `coreArchiveSha256`（4 平台压缩包 sha，
   值 = 官方 release REST API 的 asset digest，一行取：
   `gh api repos/SagerNet/sing-box/releases/tags/v<新版本> --jq '.assets[]|select(.name|test("(linux-amd64.tar.gz|windows-amd64.zip|darwin-amd64.tar.gz|darwin-arm64.tar.gz)$"))|{name,digest}'`，
   digest 形如 `sha256:<hex>`，**可原样填入** coreArchiveSha256，`fetch:core` 会自动 strip `sha256:` 前缀后比对），
   再 `npm run fetch:core -- --force` 拉新核（无需手动下载/替换二进制；不入库）。换核须确认二进制 `Tags`
   含 `with_naive_outbound`（naive 支持前提）。

   **`libcronet` 必须同步换**（2026-08-05 起）：它不再独立管理——`cronetVersion` 就是从「随包 sing-box 的
   go.mod」抄来的 Go module 伪版本，取源亦从已停更的 cronet-go Releases 改为 Go module proxy。步骤：
   ```bash
   curl -fsSL "https://proxy.golang.org/github.com/sagernet/sing-box/@v/v<新版本>.mod" | grep 'cronet-go/lib/linux_amd64'
   ```
   把伪版本回填 `cronetVersion`，按 `scripts/fetch-cronet.mjs` 头注取两类 sha（`cronetArchiveSha256`=module
   zip、`cronetLibSha256`=落地库本体），再 `npm run fetch:cronet -- --force`。忘同步不会静默——脚本每次实际
   下载前会拿 sing-box 的 `.mod` 校验同源，不一致直接 fail。

## sing-box 版本

当前版本以 `src/shared/core-manifest.json` 的 `bundledCoreVersion` 为准（**单一真值**，勿在此复述——历史上这里长期滞后于真实版本）。要求：SagerNet 官方 release 且 `Tags` 含 `with_naive_outbound`。

下载地址：https://github.com/SagerNet/sing-box/releases
