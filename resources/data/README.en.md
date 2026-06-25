# GeoIP & GeoSite data files

[简体中文](README.md) · **English**

Bundled sing-box rule-sets (`.srs`, binary format) used for routing. They ship **inside the repo** so smart-split, app-routing, and region-splitting work **offline — no startup download, no FATAL on a 404 source**. These are the factory seed: at runtime they're copied to `<userData>/rules/` and can be refreshed online via the in-app Rule Resources manager (auto-update + fswatch hot-reload).

The authoritative list lives in `src/main/services/builtin-geo-rulesets.ts` (`BUILTIN_GEO_RULESETS`). Current set — **28 files (7 geoip + 21 geosite)**:

- **China baseline (3)** — `geoip-cn` · `geosite-cn` · `geosite-geolocation-!cn`. Source: SagerNet [sing-geoip](https://github.com/SagerNet/sing-geoip) / [sing-geosite](https://github.com/SagerNet/sing-geosite) (rule-set branch).
- **App-routing presets** — `geosite-*` for popular apps (youtube, netflix, tiktok, telegram, twitter, instagram, openai, anthropic, category-ai-!cn, google, github, spotify, steam, epicgames, riot, disney) plus `geoip-*` for a few (netflix, telegram, twitter). Source: [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) (`@sing`).
- **Region splitting (Iran / Russia)** — `geosite-category-ir` · `geosite-category-ru` · `geoip-ir` · `geoip-ru`. Source: MetaCubeX/meta-rules-dat.
- **Private / LAN** — `geoip-private` · `geosite-private` (local/intranet direct).

> Committed: these `.srs` files. Not committed: the `sing-box` binary, `libcronet.*`, `dashboard/` (see `../README.md`).

## Usage

- **Smart-split mode**: CN IPs/domains go direct, the rest through the proxy.
- **App routing**: per-app proxy / direct / block, backed by the app-routing geo sets.
- **Region splitting**: domestic-direct / reverse "back-home" using the region geo sets.
- **Custom rules**: reference any tag via `res:builtin:<tag>` or `rule_set` in a route rule.

## Updating

Built-in sets refresh in-app (Rule Resources → update; auto-update is on by default). To refresh a single file manually from the official source, e.g.:

```bash
curl -L -o geoip-cn.srs https://github.com/SagerNet/sing-geoip/releases/latest/download/geoip-cn.srs
```

## Using a rule-set in a sing-box config

```json
{
  "route": {
    "rule_set": [
      { "tag": "geoip-cn", "type": "local", "format": "binary", "path": "/path/to/geoip-cn.srs" },
      { "tag": "geosite-cn", "type": "local", "format": "binary", "path": "/path/to/geosite-cn.srs" }
    ],
    "rules": [
      { "rule_set": ["geoip-cn", "geosite-cn"], "outbound": "direct" }
    ]
  }
}
```
