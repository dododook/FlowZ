# Release Guide

[简体中文](RELEASE.md) · **English**

This document describes how to ship a new FlowZ release. The single trigger for a release is **pushing a `v*` tag**: CI (`.github/workflows/release.yml`) then builds on three platforms and creates the GitHub Release automatically. Local full packaging is for verification / offline builds only and is not part of the release path.

## Prerequisites

1. **Push access** to the repo (to push tags to `origin`).
2. **Node.js 26** — match CI (`actions/setup-node@v4`, `node-version: 26`) to avoid local/CI drift.
3. **GitHub CLI (optional)** — only for manually inspecting/editing a published Release. The standard flow lets CI create the Release with the built-in `GITHUB_TOKEN`; no local `gh` is required.
4. **Go (only for building the helper locally)** — `build:helper` compiles the macOS/Windows privileged helper on the fly (the binaries are not committed). CI installs Go on the mac/win runners automatically; you only need Go locally when running `npm run dist:mac` / `dist:win`.

## Release flow (standard: push a tag to trigger CI)

1. **Bump the version**

   Edit `version` in `package.json` (currently `4.1.3`):
   ```json
   { "version": "4.1.4" }
   ```

2. **Commit and push**
   ```bash
   git add package.json
   git commit -m "chore: bump version to 4.1.4"
   git push
   ```

3. **Push the release tag**

   Create and push the `v{version}` tag (read from `package.json`) to trigger CI:
   ```bash
   npm run release:tag            # create and push vX.Y.Z
   npm run release:tag -- -u      # force-update if the remote tag already exists (delete old, re-push)
   npm run release:tag -- -y -u   # skip confirmation + force-update
   ```
   The script (`scripts/push-release.js`) checks the working tree is clean, whether the local/remote tag already exists, and — after confirmation — creates and pushes the tag. **It only pushes the tag**; building and publishing are done entirely by CI.

4. **CI builds and publishes automatically**

   On a `v*` tag push, `release.yml`:
   - runs `npm run package:<platform>` in parallel on `windows-2022` / `macos-14` / `ubuntu-latest`;
   - fetches the core and dashboard at build time (see "Build-time external artifacts"); on macOS it also packs both the arm64 and x64 `.app` into DMGs;
   - collects each platform's artifacts, generates Release Notes, and creates the GitHub Release via `softprops/action-gh-release`, uploading all installers.

5. **Verify the Release**

   Open the repo's Releases page and confirm the version and all platform artifacts are present — in particular both mac arm64 and x64 (one of them has historically gone missing).

## Local full packaging (optional: verify / offline build, no release)

```bash
npm run release:prepare   # = fetch:core + fetch:cronet + fetch:dashboard + build + package:all (win+mac+linux)
# or per platform:
npm run dist:win          # Windows (nsis + portable, x64)
npm run dist:mac          # macOS (arm64 + x64)
npm run dist:linux        # Linux (AppImage + deb, x64)
```
`dist:*` passes `--publish never`: it only produces local packages and uploads nothing. Output lands in `dist-package/`.

## Build-time external artifacts (not committed, fetched at build time)

The core and dashboard are **no longer committed to the repo**; they are fetched at build time from the official Release with SHA verification (slims the repo, prevents bloat):

| Script | Fetches |
|--------|---------|
| `fetch:core` | sing-box core (`coreArchiveSha256` verifies the archive == official release digest, zero post-processing) |
| `fetch:cronet` | cronet library (dlopen external lib on Windows/Linux; statically linked on macOS, not needed) |
| `fetch:dashboard` | clash dashboard static assets |

`package:*` / `dist:*` already chain the matching fetch steps. To change the core version: edit `bundledCoreVersion` + `coreArchiveSha256` (the archive's SHA256, which equals the official release asset digest) in `src/shared/core-manifest.json`, then re-run `fetch:core --force`.

## Artifacts

| Platform | Artifacts | Arch |
|----------|-----------|------|
| Windows | NSIS installer + portable | x64 |
| macOS | DMG | arm64, x64 |
| Linux | AppImage + deb | x64 |

> The privileged helper binary is compiled by `build:helper` (Go) into the mac/win packages; CI installs Go on the mac/win runners. Missing Go → "helper binary missing" at install time.

## Versioning

Follow [Semantic Versioning](https://semver.org/):

- **MAJOR** — incompatible changes
- **MINOR** — backward-compatible features
- **PATCH** — backward-compatible fixes

Tags look like `v4.1.4` (`push-release.js` adds the `v` prefix automatically — do not put `v` in the `version` field).

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Remote tag already exists | `npm run release:tag -- -u` to force-update, or bump `package.json` and re-release |
| Release missing a mac arch | The CI "Create DMG" step emits `::error::` for a missing arch; check that `package:mac`'s `electron-builder --arm64 --x64` produced both architectures |
| "Helper binary missing" at install | Go was absent when packaging that platform → install Go and repackage (CI installs it automatically; local `dist:mac`/`dist:win` needs Go) |
| Build fails | `npm ci` to reinstall; ensure network access (`fetch:core`/`fetch:cronet`/`fetch:dashboard` reach the official Release); check CI logs per platform |

## CI/CD

- **`.github/workflows/build.yml`** — build verification on branch pushes.
- **`.github/workflows/release.yml`** — packages on three platforms + auto-creates the Release on a `v*` tag push.
- Env: CI uses the built-in `GITHUB_TOKEN` (`permissions: contents: write`) to create the Release; the electron binary is pulled via an npmmirror mirror for speed.
- To change CI: edit the files under `.github/workflows/`.

## References

- [Electron Builder docs](https://www.electron.build/)
- [softprops/action-gh-release](https://github.com/softprops/action-gh-release)
- [GitHub Actions docs](https://docs.github.com/en/actions)
- [Semantic Versioning](https://semver.org/)
