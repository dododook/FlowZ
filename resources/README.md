# Resources directory

[English](README.md) · [中文](README.zh-CN.md)

Cross-platform resource files for the app.

## Layout

```
resources/
├── win/                          # Windows (x64)
│   ├── sing-box.exe              # sing-box binary (fetched, not committed)
│   ├── libcronet.dll             # NaiveProxy/cronet runtime lib (dlopen, fetched, not committed)
│   └── com.flowz.helper.exe      # privilege service helper (built, not committed)
├── linux/                        # Linux (x64)
│   ├── sing-box                  # sing-box binary (fetched, not committed)
│   └── libcronet.so              # NaiveProxy/cronet runtime lib (dlopen, fetched, not committed)
├── mac-x64/                      # macOS Intel (x64)
│   ├── sing-box                  # sing-box binary (fetched, not committed)
│   └── com.flowz.helper          # privilege service helper (built, not committed)
├── mac-arm64/                    # macOS Apple Silicon (arm64)
│   ├── sing-box                  # sing-box binary (fetched, not committed)
│   ├── com.flowz.helper          # privilege service helper (built, not committed)
│   └── LICENSE
├── dashboard/                    # official sing-box dashboard static assets (fetched, not committed)
├── data/                         # shared data: bundled geo rule-sets (geoip-*.srs / geosite-*.srs, committed)
├── app.png / app-gray.png        # tray icons (normal / grayed)
└── README.md
```

> The `data/` geo rule-sets, icons, and `LICENSE` are **committed**; the `sing-box` binary, `libcronet.*`, `dashboard/`, and `com.flowz.helper{,.exe}` are large or build artifacts and are **not committed** — they're fetched/built in dev/CI and packaged together with `resources/`:
>
> - `npm run fetch:core`      → per-platform `sing-box[.exe]` (SagerNet official release; pulled per `core-manifest.json` `bundledCoreVersion`, archive verified by `coreArchiveSha256`)
> - `npm run fetch:cronet`    → per-platform `libcronet.*` (NaiveProxy/cronet, runtime dlopen)
> - `npm run fetch:dashboard` → `dashboard/` (official panel, gh-pages build output)
> - `npm run build:helper`    → per-platform `com.flowz.helper{,.exe}` (privilege service, cross-compiled)
>
> The app icon itself is `build/icon.ico` / `build/icon.icns` (used by electron-builder); `resources/app*.png` are tray icons only.

## Resource management

The app accesses these files through the `ResourceManager` class:

- Auto-detects the current platform and architecture (win / linux / mac-x64 / mac-arm64).
- Handles the path difference between development and production.
- Provides a unified resource-access interface.

## Development vs production

- **Development**: loaded from the project-root `resources/`.
- **Production**: loaded from the packaged `resources/` (electron-builder `extraResources`).

## Notes

1. **Executable bit**: `sing-box` and the helper on macOS / Linux need the executable bit (`chmod +x`).
2. **File size**: the `sing-box` binary is large (~65–77 MB per platform) and affects installer size; hence it's not committed and is fetched at build time by `npm run fetch:core` (see above and "Swapping the core").
3. **Updates**: GeoIP/GeoSite data (`data/*.srs`) should be refreshed periodically; at runtime they can also be updated online into userData via the Rule Resources manager.
4. **Swapping the core**: edit `src/shared/core-manifest.json` `bundledCoreVersion` + `coreArchiveSha256` (per-platform archive sha; the value equals the official release REST API asset digest), then `npm run fetch:core -- --force`. One-liner to read the digests:
   ```bash
   gh api repos/SagerNet/sing-box/releases/tags/v<version> --jq '.assets[]|select(.name|test("(linux-amd64.tar.gz|windows-amd64.zip|darwin-amd64.tar.gz|darwin-arm64.tar.gz)$"))|{name,digest}'
   ```
   The digest looks like `sha256:<hex>` and can be pasted **as-is** into `coreArchiveSha256` (`fetch:core` strips the `sha256:` prefix before comparing). `libcronet` is managed separately by `cronetVersion` and need not change with the core (unless the official core's ABI changes). When swapping, confirm the binary's `Tags` include `with_naive_outbound` (prerequisite for naive support).

## sing-box version

Current: **1.14.0-alpha.34** (SagerNet official release; `Tags` include `with_naive_outbound`).

Downloads: https://github.com/SagerNet/sing-box/releases
