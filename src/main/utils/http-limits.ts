/**
 * GitHub API JSON 响应字节上限（OOM 防护，issue: OOM 审计 #1/#2）。
 *
 * 背景：core-downloader / UpdateService / RuleResourceManager 三处经 net.request 抓 GitHub API JSON
 * （releases / git-trees catalog），res.on('data') 累加 data/chunks 时**无字节上限**。当 api.github.com
 * 或其加速镜像被劫持 / 被中间设备或 WAF 接管，可在超时窗口内回灌 GB 级响应体 → 字符串/Buffer 无界累加
 * + Buffer.concat/toString/JSON.parse 峰值多重放大 → 撞 V8 max string length(~512MB) / 堆上限 → 主进程
 * FATAL OOM（启动后 5s 自动检查更新即可被诱发，无需用户交互）。
 *
 * GitHub releases / catalog tree JSON 实际体量 < 数 MB，16MiB 上限足够正常使用 + 截断恶意灌流。
 * 与同仓现成护栏一致（WarpService data.length>1MB / IpInfoService body.length>8KB 即 destroy/abort）。
 */
export const MAX_GITHUB_JSON_BYTES = 16 * 1024 * 1024;
