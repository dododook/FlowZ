# 发布指南

**简体中文** · [English](RELEASE.en.md)

本文档描述如何发布 FlowZ 新版本。发布的「单一触发点」是**推送 `v*` tag**：CI（`.github/workflows/release.yml`）随后在三平台构建并自动创建 GitHub Release。本地全量打包仅用于验证/离线出包，不走发布路径。

## 前置要求

1. **仓库写权限**：能向 `origin` 推送 tag。
2. **Node.js 26**：与 CI（`actions/setup-node@v4`，`node-version: 26`）一致，避免本地/CI 行为漂移。
3. **GitHub CLI（可选）**：仅用于手动查看/编辑已发布 Release；标准流程由 CI 用内置 `GITHUB_TOKEN` 自动建 Release，无需本地 `gh`。
4. **Go（仅本地打包 helper 时需要）**：`build:helper` 现编现打 macOS/Windows 提权 helper（二进制不入库）。CI 已在 mac/win runner 自动装 Go；仅当你本地 `npm run dist:mac`/`dist:win` 时才需本机有 Go。

## 发布流程（标准：推 tag 触发 CI）

1. **更新版本号**

   编辑 `package.json` 的 `version`（当前 `4.1.3`）：
   ```json
   { "version": "4.1.4" }
   ```

2. **提交并推送**
   ```bash
   git add package.json
   git commit -m "chore: bump version to 4.1.4"
   git push
   ```

3. **推送 Release tag**

   用脚本按 `package.json` 版本号创建并推送 `v{version}` tag（触发 CI）：
   ```bash
   npm run release:tag            # 创建并推送 vX.Y.Z
   npm run release:tag -- -u      # 远程已存在同名 tag 时强制更新（删旧 tag 重推）
   npm run release:tag -- -y -u   # 跳过确认 + 强制更新
   ```
   脚本（`scripts/push-release.js`）会校验工作区干净度、检查本地/远程 tag 是否已存在，并在确认后创建并推送 tag。**它只推 tag**——构建与发布全部由 CI 完成。

4. **CI 自动构建并发布**

   推送 `v*` tag 后，`release.yml` 自动：
   - 在 `windows-2022` / `macos-14` / `ubuntu-latest` 三平台并行 `npm run package:<platform>`；
   - 构建期拉取内核与面板（见下「构建期外部产物」），mac 额外把 arm64/x64 两份 `.app` 打成 DMG；
   - 汇总各平台产物，生成 Release Notes，经 `softprops/action-gh-release` 创建 GitHub Release 并上传全部安装包。

5. **检查 Release**

   打开仓库 Releases 页，确认版本、各平台产物齐全（尤其 mac arm64 与 x64 两份，历史上易缺其一）。

## 本地全量打包（可选：验证 / 离线出包，不触发发布）

```bash
npm run release:prepare   # = fetch:core + fetch:cronet + fetch:dashboard + build + package:all（win+mac+linux）
# 或按平台：
npm run dist:win          # Windows（nsis + portable，x64）
npm run dist:mac          # macOS（arm64 + x64）
npm run dist:linux        # Linux（AppImage + deb，x64）
```
`dist:*` 带 `--publish never`，只产出本地包、不上传。产物在 `dist-package/`。

## 构建期外部产物（不入库，构建时拉取）

内核与面板**不再随仓库入库**，改为构建期从官方 Release 按 SHA 校验拉取（仓库瘦身、防膨胀）：

| 脚本 | 拉取内容 |
|------|----------|
| `fetch:core` | sing-box 内核（`coreArchiveSha256` 校验压缩包 = 官方 release digest，零后处理） |
| `fetch:cronet` | cronet 库（Windows/Linux dlopen 外部库；macOS 静态编入不需要） |
| `fetch:dashboard` | clash 面板静态资源 |

`package:*` / `dist:*` 已串联对应 fetch 步骤。换内核版本：改 `src/shared/core-manifest.json` 的 `bundledCoreVersion` + `coreArchiveSha256`（压缩包 SHA256，= 官方 release asset digest）后重新 `fetch:core --force`。

## 打包产物

| 平台 | 产物 | 架构 |
|------|------|------|
| Windows | NSIS 安装器 + portable | x64 |
| macOS | DMG | arm64、x64 |
| Linux | AppImage + deb | x64 |

> 提权 helper 二进制由 `build:helper`（Go）现编现打进 mac/win 包；CI 在 mac/win runner 装 Go。缺 Go → 安装时报「提权助手二进制缺失」。

## 版本号规范

遵循 [语义化版本](https://semver.org/lang/zh-CN/)：

- **MAJOR**：不兼容变更
- **MINOR**：向下兼容的新功能
- **PATCH**：向下兼容的修复

tag 形如 `v4.1.4`（`push-release.js` 自动加 `v` 前缀，勿手写带 `v` 的 version）。

## 故障排除

| 问题 | 处理 |
|------|------|
| 远程 tag 已存在 | `npm run release:tag -- -u` 强制更新，或改 `package.json` 版本号后重发 |
| Release 缺 mac 某架构包 | CI「Create DMG」步对缺失架构会 `::error::`；检查 `package:mac` 的 `electron-builder --arm64 --x64` 是否两架构都产出 |
| 安装报「提权助手二进制缺失」 | 该平台打包时缺 Go → 装 Go 后重打（CI 已自动装；本地 `dist:mac`/`dist:win` 需本机 Go） |
| 构建失败 | `npm ci` 重装依赖；确认能联网（`fetch:core`/`fetch:cronet`/`fetch:dashboard` 需访问官方 Release）；查 CI 日志定位平台 |

## CI/CD 配置

- **`.github/workflows/build.yml`**：推送到分支时构建校验。
- **`.github/workflows/release.yml`**：推送 `v*` tag 时三平台打包 + 自动建 Release。
- 环境变量：CI 用内置 `GITHUB_TOKEN`（`permissions: contents: write`）创建 Release；electron 二进制走 npmmirror 镜像加速。
- 修改 CI：编辑 `.github/workflows/` 下的文件。

## 参考资料

- [Electron Builder 文档](https://www.electron.build/)
- [softprops/action-gh-release](https://github.com/softprops/action-gh-release)
- [GitHub Actions 文档](https://docs.github.com/en/actions)
- [语义化版本规范](https://semver.org/lang/zh-CN/)
