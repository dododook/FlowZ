/**
 * sing-box 内核更新的「网络获取」职责（从 CoreUpdateService 抽出）：
 * 拉 release 列表 / 挑选平台资产 / 下载（含停滞看门狗 + 完整性校验 + 镜像回退）/ 解压定位可执行文件。
 *
 * 仅依赖 logManager（日志）+ configProvider（读 ghProxyPrefix 镜像前缀）；不耦合安装/回滚/版本状态流程，
 * 故可独立成块。网络/解压均为 runtime 行为，本机不可单测——逐字保留原实现；纯逻辑（资产挑选）已下沉
 * singbox-asset.findSuitableSingboxAsset 单测覆盖。
 */

import { app, net, session, Session } from 'electron';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { LogManager } from './LogManager';
import type { UserConfig } from '../../shared/types';
import { APP_USER_AGENT } from '../../shared/constants';
import { ghMirrorUrl, normalizeGhProxyPrefix } from '../../shared/gh-proxy';
import { createIdleTimeout, parseExpectedBytes } from './download-hardening';
import { powershellPath } from '../utils/win-system32';
import { MAX_GITHUB_JSON_BYTES } from '../utils/http-limits';
import { findSuitableSingboxAsset } from './singbox-asset';
import { UpdateNetwork } from './UpdateNetwork';

export class CoreDownloader {
  // direct 自举兜底会话（强制 mode:direct）：核下载是自举链路，UpdateNetwork 未注入 / update-in 端口不可用 /
  // sessionFor 失败时回落此口——绝不回落 default session（核更新链路统一经本类专用会话，default session 已
  // 回归系统代理且 bootstrap 期不可控）；TUN 模式 direct 由 OS 层透明捕获，系统代理模式直连 GitHub（实测均可达）。
  private updateDirectSession: Session | null = null;
  // §8 四链路收口：核更新链路也接入 update-in（socks）。viaProxy/port 决策已收口到 UpdateNetwork.
  // resolveSessionForMainUpdate（类2，providers 由 index.ts 一次注入）；本类只持 updateNetwork 引用 + 自举兜底。
  private updateNetwork: UpdateNetwork | null = null;

  constructor(
    private readonly logManager: LogManager,
    // 注入配置读取器（读 ghProxyPrefix 镜像前缀）；未配置时解析为 null。
    private readonly configProvider: () => Promise<UserConfig | null>
  ) {}

  /** §8：注入更新链路统一会话层（类2：决策 providers 改由 index.ts 注入 updateNetwork.setMainUpdateProviders）。 */
  setUpdateNetwork(updateNetwork: UpdateNetwork): void {
    this.updateNetwork = updateNetwork;
  }

  /** direct 自举兜底会话（强制 mode:direct，绕 default session http 入站挂死）。 */
  private async getDirectSession(): Promise<Session> {
    if (this.updateDirectSession) return this.updateDirectSession;
    const s = session.fromPartition('flowz-core-update-direct');
    await s.setProxy({ mode: 'direct' });
    this.updateDirectSession = s;
    return s;
  }

  /**
   * 核更新链路（检查/下载）统一会话。viaProxy/port 决策收口到 UpdateNetwork.resolveSessionForMainUpdate（类2
   * 三链路单点防漂移）。恒返回 Session（非 undefined）——核自举绝不回落 default session（http 入站挂死）：
   * 未注入 updateNetwork / resolveSessionForMainUpdate 极罕见 reject → 回本类 direct 自举兜底。
   */
  private async updateSession(): Promise<Session> {
    if (!this.updateNetwork) return this.getDirectSession();
    return this.updateNetwork.resolveSessionForMainUpdate().catch(() => this.getDirectSession());
  }

  async fetchReleases(): Promise<any[]> {
    const sess = await this.updateSession();
    return new Promise((resolve, reject) => {
      let settled = false;
      const request = net.request({
        method: 'GET',
        url: 'https://api.github.com/repos/SagerNet/sing-box/releases',
        session: sess,
      });
      // 单点收口：防 request/response 双错误源重复 settle；clear timeout；之后任何回调都 no-op。
      const finish = (err: Error | null, val?: any[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(val as any[]);
      };
      // 兜底超时：net.request 在连接被中间设备静默吞掉时可能长时间不触发 error → 前端永久转圈。15s 后主动 abort+reject。
      const timer = setTimeout(() => {
        try {
          request.abort();
        } catch {
          /* ignore */
        }
        finish(new Error('检查更新超时（GitHub 不可达或被网络拦截）'));
      }, 15000);

      request.setHeader('User-Agent', APP_USER_AGENT);
      request.setHeader('Accept', 'application/vnd.github.v3+json');

      request.on('response', (res) => {
        let data = '';
        res.on('data', (chunk) => {
          // 已收口（超限/超时/错误）后忽略 drain 中的残帧：abort 不同步停止 res，
          // 已 buffer 的帧仍会触发 data，若继续累加会徒增内存峰值。
          if (settled) return;
          data += chunk.toString();
          // OOM 防护：GitHub api 被劫持/WAF 接管可回灌 GB 级响应撞 V8 堆/512MB string 上限。
          // 超 16MiB 即 abort + 单点收口 finish（releases JSON 实际 < 数 MB；与超时同路径）。
          if (data.length > MAX_GITHUB_JSON_BYTES) {
            try {
              request.abort();
            } catch {
              /* ignore */
            }
            finish(new Error('GitHub 响应过大（疑似被劫持/WAF 拦截）'));
            return;
          }
        });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              finish(null, JSON.parse(data));
            } catch {
              finish(new Error('解析 GitHub 响应失败'));
            }
          } else if (res.statusCode === 403) {
            finish(new Error('GitHub API 访问频率限制 (403)，请稍后再试或使用代理'));
          } else {
            finish(new Error(`GitHub API 错误: ${res.statusCode}`));
          }
        });
        // 关键：response 阶段断连（ERR_CONNECTION_CLOSED 等）从 res emit 'error'，缺此 handler 会逃逸成
        // 主进程 uncaughtException，且 Promise 永不 settle → checkUpdate await 永挂 → 前端检查更新永久转圈。
        res.on('error', (err: Error) => finish(err));
      });

      request.on('error', (err: Error) => finish(err));
      request.end();
    });
  }

  /** 挑选适配当前平台/架构的资产；纯逻辑在 singbox-asset，此处仅注入 process 平台/架构。 */
  findSuitableAsset(assets: any[]): any {
    return findSuitableSingboxAsset(assets, process.platform, process.arch);
  }

  /**
   * 下载内核压缩包到临时文件。
   *
   * @param expectedSha256 期望的 sha256（小写裸 hex，来自 GitHub API 的 asset.digest）。**调用方必须传**：
   *   下载失败会回落 gh-proxy 第三方镜像，而 Content-Length 只能挡截断、挡不住「长度一样但内容被换」。
   *   摘要取自 api.github.com 直连响应、不经镜像，故拿它校验镜像给的字节是有意义的。
   *   传 undefined 时不校验——仅为兼容尚未接线的调用方保留，新调用方不要这么用（服务层已 fail-closed）。
   */
  async downloadFile(url: string, isRetry = false, expectedSha256?: string): Promise<string> {
    let ext = process.platform === 'win32' ? '.zip' : '.tar.gz';
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      // path.extname 对于 .tar.gz 只会返回 .gz
      const urlExt = path.extname(pathname);
      if (urlExt) {
        if (pathname.endsWith('.tar.gz')) {
          ext = '.tar.gz';
        } else {
          ext = urlExt;
        }
      }
    } catch (e) {
      this.logManager.addLog('warn', `解析下载 URL 后缀失败: ${e}`, 'CoreDownloader');
    }

    // Windows 且后缀不是 .zip → 强制使用 .zip（Sing-box Windows 构建通常是 zip）
    if (process.platform === 'win32' && ext !== '.zip') {
      ext = '.zip';
    }

    // 文件名必须含随机段：**只用 Date.now() 会撞名**——镜像重试紧跟首发失败，两次调用常落在同一毫秒，
    // 于是重试用的路径与首发相同，而首发 handleError 里的异步 fs.unlink 会把重试刚写好的文件删掉。
    // 后果视时序而定：轻则解压 ENOENT，重则校验读不到文件。macOS CI 实测命中，Windows 因时序不同侥幸躲过。
    const tempPath = path.join(
      app.getPath('temp'),
      `sing-box-core-update-${Date.now()}-${randomBytes(4).toString('hex')}${ext}`
    );
    const file = fs.createWriteStream(tempPath);
    const sess = await this.updateSession();
    // 下载失败兜底镜像前缀：优先用户配置的 ghProxyPrefix，否则用内置 preset[0]（gh-proxy.org）。
    // 旧硬编码 mirror.ghproxy.com 已停服，复用 shared/gh-proxy 单一权威（同 RuleResourceManager 重试链）。
    let ghPrefix: string | undefined;
    try {
      const cfg = await this.configProvider();
      const raw = cfg?.ghProxyPrefix;
      ghPrefix = raw ? (normalizeGhProxyPrefix(raw) ?? undefined) : undefined;
    } catch {
      ghPrefix = undefined;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      // 停滞看门狗：连接/下载 30s 无进展即 abort + handleError（github 链接自动换镜像重试一次），防下载挂起致
      // updateCore 永不 resolve、前端「更新」按钮永久转圈。收口 download-hardening 单一真值。
      const idle = createIdleTimeout(() => {
        try {
          request.abort();
        } catch {
          /* ignore */
        }
        handleError(new Error('下载停滞超时（30s 无数据，网络中断或被拦截）'));
      }, 30000);

      const handleError = (err: any) => {
        if (settled) return;
        settled = true;
        idle.clear();
        file.close();
        fs.unlink(tempPath, () => {});

        // 遇到网络错误，且是第一次尝试，并且是 github 链接，尝试使用加速镜像
        if (!isRetry && url.includes('github.com')) {
          const mirrorUrl = ghMirrorUrl(url, ghPrefix);
          this.logManager.addLog(
            'warn',
            `下载出错，尝试使用加速镜像: ${err.message}`,
            'CoreDownloader'
          );
          this.downloadFile(mirrorUrl, true, expectedSha256).then(resolve).catch(reject);
          return;
        }

        reject(err);
      };

      const request = net.request({ url, session: sess });
      request.setHeader('User-Agent', APP_USER_AGENT);

      request.on('response', (response) => {
        if (response.statusCode >= 400) {
          if (settled) return;
          settled = true;
          idle.clear();
          file.close();
          fs.unlink(tempPath, () => {});
          reject(new Error(`Download failed: ${response.statusCode}`));
          return;
        }

        // 完整性校验：累计字节与 Content-Length 比对，拦截被截断/中断的下载流入解压
        const expectedBytes = parseExpectedBytes(response.headers['content-length']);
        let receivedBytes = 0;

        response.on('data', (chunk) => {
          idle.arm(); // 每收到数据重置停滞计时
          receivedBytes += chunk.length;
          file.write(chunk);
        });

        response.on('end', () => {
          idle.clear();
          file.close(() => {
            if (!isNaN(expectedBytes) && receivedBytes !== expectedBytes) {
              // 截断的 GitHub 下载会经 handleError 自动换镜像重试一次
              handleError(
                new Error(
                  `下载不完整：收到 ${receivedBytes} 字节，期望 ${expectedBytes}（可能被截断）`
                )
              );
              return;
            }
            // 内容校验：Content-Length 只证明「长度对」，证明不了「内容对」——镜像可以给出长度相同的另一份
            // 字节。摘要来自 api.github.com 直连响应，不经镜像，故此处是镜像投毒的唯一实际拦截点。
            // 走 handleError 而非直接 reject：GitHub 直连那次若因传输损坏对不上，仍可换镜像重试一次，
            // 而重试拿到的字节同样要过这道校验（摘要已随重试传下去），不会因为「重试」而降级。
            if (expectedSha256) {
              let actual: string;
              try {
                actual = createHash('sha256').update(fs.readFileSync(tempPath)).digest('hex');
              } catch (e) {
                handleError(new Error(`校验下载内容失败：无法读取临时文件（${e}）`));
                return;
              }
              if (actual !== expectedSha256) {
                handleError(
                  new Error(
                    `内核完整性校验失败：sha256 期望 ${expectedSha256}，实得 ${actual}（下载被篡改或镜像返回了不同的文件）`
                  )
                );
                return;
              }
            }
            if (settled) return;
            settled = true;
            resolve(tempPath);
          });
        });

        response.on('error', handleError);
      });

      request.on('error', handleError);

      idle.arm(); // 连接阶段也启动停滞计时（连接挂起 30s 超时）
      request.end();
    });
  }

  async extractCore(filePath: string): Promise<{ corePath: string; extractDir: string }> {
    // 简化实现：不引入 adm-zip/tar 库，为稳健性改用系统命令（tar / powershell Expand-Archive）。

    const extractDir = path.join(app.getPath('temp'), `sing-box-extracted-${Date.now()}`);
    fs.mkdirSync(extractDir);

    try {
      if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        execSync(
          `"${powershellPath()}" -command "Expand-Archive -Path '${filePath}' -DestinationPath '${extractDir}' -Force"`
        );
      } else {
        const { execSync } = require('child_process');
        if (filePath.endsWith('.zip')) {
          execSync(`unzip -o "${filePath}" -d "${extractDir}"`);
        } else {
          execSync(`tar -xzf "${filePath}" -C "${extractDir}"`);
        }
      }

      // 查找解压后的可执行文件
      const exeName = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';

      const findFile = (dir: string): string | null => {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            const found = findFile(fullPath);
            if (found) return found;
          } else if (file === exeName) {
            return fullPath;
          }
        }
        return null;
      };

      const corePath = findFile(extractDir);
      if (!corePath) {
        throw new Error('无法在压缩包中找到 sing-box 可执行文件');
      }

      return { corePath, extractDir };
    } catch (error) {
      // 报错时也尝试清理临时目录
      try {
        if (fs.existsSync(extractDir)) {
          fs.rmSync(extractDir, { recursive: true, force: true });
        }
      } catch {
        // Ignore cleanup errors during recovery
      }
      throw new Error(`解压失败: ${(error as any).message}`);
    }
  }
}
