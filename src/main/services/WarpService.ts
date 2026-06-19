/**
 * Cloudflare WARP 设备注册（主进程）。匿名注册一台设备 → 产出一份 WireGuard 配置草稿，
 * 渲染端用它填充 WG 表单、用户确认后按普通 WireGuard 节点保存（FlowZ WG endpoint 已支持 reserved）。
 *
 * 关键约束（research 实测）：Cloudflare WAF 校验 TLS 指纹——必须 **TLS1.2-only + HTTP/1.1 + okhttp UA**，
 * 否则返 1020/403。故此处刻意用 node https（可钉 TLS 版本）而非 Electron net.fetch（会协商 TLS1.3/h2）。
 * URL 为固定 CF 域名，无 SSRF 面；license key 用户提供、随 body 发往固定域名。
 */
import * as https from 'https';
import * as crypto from 'crypto';
import type { LogManager } from './LogManager';
import {
  WARP_API_BASE,
  WARP_API_VERSION,
  WARP_CLIENT_VERSION,
  WARP_USER_AGENT,
  WARP_MTU,
  WARP_ALLOWED_IPS,
  buildRegisterBody,
  parseRegisterResponse,
  buildUnregisterRequest,
  classifyDeregisterResult,
  type WarpWireGuardDraft,
  type DeregisterResult,
} from '../../shared/warp';

export type { WarpWireGuardDraft };

const REQ_TIMEOUT_MS = 15000;

export class WarpService {
  constructor(private logManager?: LogManager) {}

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.logManager?.addLog(level, message, 'WarpService');
  }

  /** 生成 Curve25519 keypair → { privateKey, publicKey } base64（取 DER 末 32 字节裸 key）。 */
  private generateKeyPair(): { privateKey: string; publicKey: string } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const pubDer = publicKey.export({ type: 'spki', format: 'der' });
    const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
    return {
      publicKey: pubDer.subarray(pubDer.length - 32).toString('base64'),
      privateKey: privDer.subarray(privDer.length - 32).toString('base64'),
    };
  }

  /** TLS1.2-only + HTTP/1.1 的 JSON 请求。非 2xx 抛错（带状态码 + 截断响应，便于定位 1020/版本失效）。 */
  private request(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request(
        {
          method,
          hostname: u.hostname,
          path: u.pathname + u.search,
          port: 443,
          headers,
          timeout: REQ_TIMEOUT_MS,
          // 钉 TLS1.2（默认 https 走 HTTP/1.1，无需显式关 h2）；伪装 App TLS 指纹避开 Cloudflare 1020。
          minVersion: 'TLSv1.2',
          maxVersion: 'TLSv1.2',
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          // 响应流错误（对端收到 header 后 RST/提前关闭）发在 res 上而非 req → 必须显式 reject，
          // 否则 'end' 不触发、req 'error'/'timeout' 也不再触发，Promise 永挂、按钮空转。
          res.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
          res.on('data', (c) => {
            data += c;
            if (data.length > 1_000_000) req.destroy(new Error('WARP 响应过大'));
          });
          res.on('end', () => {
            const status = res.statusCode || 0;
            if (status < 200 || status >= 300) {
              reject(new Error(`WARP API ${status}: ${data.slice(0, 200)}`));
              return;
            }
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error('WARP API 返回非 JSON'));
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('WARP API 超时')));
      if (body) req.write(body);
      req.end();
    });
  }

  /**
   * 注册一台匿名 WARP 设备并产出 WG 草稿。licenseKey 非空则注册后应用 WARP+ license（失败不阻断，降级免费）。
   * token 仅本流程内存使用、用后即弃，不持久化（公开 issue 附件零密钥原则）。
   */
  async register(opts?: { licenseKey?: string }): Promise<WarpWireGuardDraft> {
    const { privateKey, publicKey } = this.generateKeyPair();
    const base = `${WARP_API_BASE}/${WARP_API_VERSION}`;
    const headers = {
      'User-Agent': WARP_USER_AGENT,
      'CF-Client-Version': WARP_CLIENT_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const body = JSON.stringify(buildRegisterBody(publicKey, new Date().toISOString()));
    this.log('info', `WARP 注册中（version=${WARP_API_VERSION}）…`);
    const regJson = await this.request('POST', `${base}/reg`, headers, body);
    const result = parseRegisterResponse(regJson);
    const token = regJson?.token;

    const licenseKey = opts?.licenseKey?.trim();
    if (licenseKey && token && result.deviceId) {
      try {
        const acct = await this.request(
          'PUT',
          `${base}/reg/${result.deviceId}/account`,
          { ...headers, Authorization: `Bearer ${token}` },
          JSON.stringify({ license: licenseKey })
        );
        result.warpPlus = !!acct?.warp_plus;
        result.license = acct?.license || result.license;
        this.log('info', `WARP+ license 已应用（warp_plus=${result.warpPlus}）`);
      } catch (e: any) {
        this.log('warn', `WARP+ license 应用失败（降级免费版）: ${e?.message ?? e}`);
      }
    }

    this.log(
      'info',
      `WARP 注册成功：${result.address}:${result.port}（warp_plus=${result.warpPlus}）`
    );
    return {
      address: result.address,
      port: result.port,
      privateKey,
      peerPublicKey: result.peerPublicKey,
      localAddress: result.localAddress,
      allowedIPs: [...WARP_ALLOWED_IPS],
      reserved: result.reserved,
      mtu: WARP_MTU,
      meta: {
        deviceId: result.deviceId,
        accountId: result.accountId,
        license: result.license,
        warpPlus: result.warpPlus,
      },
      // 破当前「token 用后即弃」：保留 deviceId+token 随节点落 wireguardSettings.warpDevice，作远端设备自删凭据
      // （与 privateKey 同信任类、同脱敏）。无 token 时存空串——register 应返 token，缺则后续删除按「无凭据」跳过入队。
      warpDevice: { deviceId: result.deviceId, token: token || '' },
    };
  }

  /**
   * 注销一台已注册的 WARP 设备（删除节点时调）。裸 DELETE /{version}/reg/{deviceId} + Bearer token + 同
   * register 的 TLS1.2/okhttp 指纹（否则 1020）。**捕获 HTTP 状态码**（不像 register 非 2xx 即抛丢失状态）→
   * 经 classifyDeregisterResult 返 done/drop/retry；网络异常 → classify(null, err)=retry。
   * 不抛异常（队列重试语义靠返回值，不靠 try/catch）。日志只打 deviceId 前缀，绝不打 token。
   */
  async unregister(deviceId: string, token: string): Promise<DeregisterResult> {
    if (!deviceId || !token) return 'drop'; // 无凭据无从注销（旧节点 / 缺 token），视作放弃出队。
    const { url, headers } = buildUnregisterRequest(WARP_API_VERSION, deviceId, token);
    const idPrefix = deviceId.slice(0, 8);
    try {
      const { status, body } = await this.requestStatus('DELETE', url, headers);
      // 关键：把响应体一并传给分类——Cloudflare WAF 1020（版本串失效）常以 **403 携带 body code 1020** 返回，
      // 须优先于 401/403 的 drop 判定走 retry。若只传 status，403+1020 会被误当「token 死」放弃 → 版本过期时
      // 全部设备注销被永久误放弃。body 作 err 文本喂 classifyDeregisterResult，使 1020 检测在注销路径真正生效。
      const result = classifyDeregisterResult(status, body || undefined);
      this.log('info', `WARP 设备注销 ${idPrefix}… → HTTP ${status}（${result}）`);
      return result;
    } catch (e: any) {
      // 网络失败 / 超时：无 HTTP 状态 → retry（等网络恢复）。
      const result = classifyDeregisterResult(null, e);
      this.log('info', `WARP 设备注销 ${idPrefix}… 网络异常（${result}）: ${e?.message ?? e}`);
      return result;
    }
  }

  /**
   * 同 request 的 TLS1.2-only + HTTP/1.1，但**返回 HTTP 状态码 + 截断响应体**（注销需据 4xx/5xx 分类，不能像
   * register 那样非 2xx 即抛丢失状态）。保留响应体前段（≤512B）供调用方判 body-code-1020（WAF/版本失效）——
   * 若丢弃 body，403+1020 与「token 死的 403」无法区分。仅网络层错误才 reject。
   */
  private requestStatus(
    method: string,
    url: string,
    headers: Record<string, string>
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request(
        {
          method,
          hostname: u.hostname,
          path: u.pathname + u.search,
          port: 443,
          headers,
          timeout: REQ_TIMEOUT_MS,
          minVersion: 'TLSv1.2',
          maxVersion: 'TLSv1.2',
        },
        (res) => {
          res.setEncoding('utf8');
          // 响应流错误（对端收 header 后 RST/提前关闭）发在 res 上而非 req → 必须显式 reject，否则永挂。
          res.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
          let body = '';
          let total = 0; // 累计字节（独立于 body——body 前 512B 后早停拼接，不能复用其长度判超大）。
          res.on('data', (c) => {
            total += c.length;
            // 只保留前 512 字节（足够含 CF body code 如 1020），但与 request 一致对超大响应主动 destroy，
            // 防异常/恶意对端持续涌数据（timeout 是空闲超时、连续数据不触发）。
            if (body.length < 512) body += c;
            if (total > 1_000_000) req.destroy(new Error('WARP 响应过大'));
          });
          res.on('end', () => resolve({ status: res.statusCode || 0, body: body.slice(0, 512) }));
        }
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('WARP API 超时')));
      req.end();
    });
  }
}
