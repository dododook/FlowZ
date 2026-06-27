/**
 * sing-box 内核更新的「网络获取」职责（从 CoreUpdateService 抽出）：
 * 拉 release 列表 / 挑选平台资产 / 下载（含停滞看门狗 + 完整性校验 + 镜像回退）/ 解压定位可执行文件。
 *
 * 仅依赖 logManager（日志）+ configProvider（读 ghProxyPrefix 镜像前缀）；不耦合安装/回滚/版本状态流程，
 * 故可独立成块。网络/解压均为 runtime 行为，本机不可单测——逐字保留原实现；纯逻辑（资产挑选）已下沉
 * singbox-asset.findSuitableSingboxAsset 单测覆盖。
 */

import { app, net, session, Session } from 'electron';
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
import { resolveMainSessionViaProxy } from '../../shared/update-proxy';

export class CoreDownloader {
  // direct 自举兜底会话（强制 mode:direct）：核下载是自举链路，UpdateNetwork 未注入 / update-in 端口不可用 /
  // sessionFor 失败时回落此口——绝不回落 default session（核更新链路统一经本类专用会话，default session 已
  // 回归系统代理且 bootstrap 期不可控）；TUN 模式 direct 由 OS 层透明捕获，系统代理模式直连 GitHub（实测均可达）。
  private updateDirectSession: Session | null = null;
  // §8 四链路收口：核更新链路也接入 update-in（socks）。viaProxy（resolveMainSessionViaProxy）时经 update-in→route→
  // proxy；否则走 direct 兜底（自举）。构造后由 CoreUpdateService 转发、index 装配。
  private updateNetwork: UpdateNetwork | null = null;
  private proxyRunningProvider: (() => boolean) | null = null;
  private updateInPortProvider: (() => number | null) | null = null;

  constructor(
    private readonly logManager: LogManager,
    // 注入配置读取器（读 ghProxyPrefix 镜像前缀 + mainSessionViaProxy）；未配置时解析为 null。
    private readonly configProvider: () => Promise<UserConfig | null>
  ) {}

  /** §8：注入更新链路统一会话层 + 代理运行态/update-in 端口读取器（CoreUpdateService 转发，index 装配）。 */
  setUpdateNetwork(
    updateNetwork: UpdateNetwork,
    proxyRunningProvider: () => boolean,
    updateInPortProvider: () => number | null
  ): void {
    this.updateNetwork = updateNetwork;
    this.proxyRunningProvider = proxyRunningProvider;
    this.updateInPortProvider = updateInPortProvider;
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
   * 核更新链路（检查/下载）统一会话。viaProxy（resolveMainSessionViaProxy = running && mainSessionViaProxy!==false）
   * 且 update-in 端口可用 → 经 update-in（socks→route→proxy）；否则 direct 兜底（自举：核下载恒可达 direct+mirror）。
   * 恒返回 Session（非 undefined）——核自举绝不回落 default session（http 入站挂死）；sessionFor 失败亦回 direct。
   */
  private async updateSession(): Promise<Session> {
    if (!this.updateNetwork) return this.getDirectSession();
    let viaProxy = false;
    let updateInPort = 0;
    try {
      const cfg = await this.configProvider();
      const running = this.proxyRunningProvider ? this.proxyRunningProvider() : false;
      viaProxy = resolveMainSessionViaProxy(running, cfg?.mainSessionViaProxy);
      updateInPort = this.updateInPortProvider?.() ?? 0;
    } catch {
      viaProxy = false;
    }
    if (viaProxy && updateInPort <= 0) viaProxy = false;
    try {
      return await this.updateNetwork.sessionFor(viaProxy, updateInPort);
    } catch {
      return this.getDirectSession(); // sessionFor/setProxy 失败 → direct 兜底（自举绝不回 default session）
    }
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
          // OOM 防护（审计 #2）：GitHub api 被劫持/WAF 接管可回灌 GB 级响应撞 V8 堆/512MB string 上限。
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

  async downloadFile(url: string, isRetry = false): Promise<string> {
    // 根据系统平台设置合理的默认扩展名
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

    // 如果是 Windows，且后缀不是 .zip，强制使用 .zip (因为 Sing-box Windows 构建通常是 zip)
    // 这是一个保险措施
    if (process.platform === 'win32' && ext !== '.zip') {
      ext = '.zip';
    }

    const tempPath = path.join(app.getPath('temp'), `sing-box-core-update-${Date.now()}${ext}`);
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
          this.downloadFile(mirrorUrl, true).then(resolve).catch(reject);
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
    // 这是一个简化实现，处理 zip 和 tar.gz 需要引入 adm-zip 或 tar 库
    // 假设项目中可能有这些依赖，或者使用系统命令
    // 为了稳健性，这里使用系统命令 (tar / powershell Expand-Archive)

    const extractDir = path.join(app.getPath('temp'), `sing-box-extracted-${Date.now()}`);
    fs.mkdirSync(extractDir);

    try {
      if (process.platform === 'win32') {
        // Windows: 使用 PowerShell 解压 zip
        const { execSync } = require('child_process');
        execSync(
          `"${powershellPath()}" -command "Expand-Archive -Path '${filePath}' -DestinationPath '${extractDir}' -Force"`
        );
      } else {
        // macOS/Linux: 使用 tar
        const { execSync } = require('child_process');
        // 检测是 zip 还是 tar.gz
        if (filePath.endsWith('.zip')) {
          execSync(`unzip -o "${filePath}" -d "${extractDir}"`);
        } else {
          execSync(`tar -xzf "${filePath}" -C "${extractDir}"`);
        }
      }

      // 查找解压后的可执行文件
      const exeName = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';

      // 递归查找
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
