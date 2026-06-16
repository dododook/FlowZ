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
  type WarpWireGuardDraft,
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
    };
  }
}
