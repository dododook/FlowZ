/**
 * 解锁检测传输层 —— Electron `net.request` 薄封装（经检测专用 session 走用户真实分流出口）。
 *
 * 复用 UpdateNetwork/core-downloader 已实证的 net.request 范式（net.request 经 socks 入站不挂死）。
 * 与检测判定解耦：只负责「发一个请求 → 拿 {status, headers, body, redirectChain}」，判定在 checkers.ts。
 *
 * 硬约束（防三类挂死/失控）：
 *  - 单请求 8s 超时（settled 守卫 + abort），防 promise 永挂死整条 allSettled 编排；
 *  - body 上限 1.5MB，超限截断即 abort（防劫持页/WAF 大响应撑爆内存）；
 *  - redirect:'manual' 逐跳记 Location 后 followRedirect（≤5 跳），超跳 abort —— 供 checker 读重定向链
 *    判地区/封禁，而非盲跟。任何异常/网络错 → status:0 + error，绝不抛（checker 据此落 timeout）。
 */

import { net, type ClientRequest, type Session } from 'electron';
import { MAX_BODY_BYTES, MAX_REDIRECTS, REQ_TIMEOUT_MS } from './unlock-endpoints';

export interface UnlockRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** POST body（原样 write）。 */
  body?: string;
  /** 覆盖默认最大重定向跳数（默认 MAX_REDIRECTS）。 */
  maxRedirects?: number;
  /** 覆盖默认单请求超时（默认 REQ_TIMEOUT_MS）。供整轮检测总预算（issue 1）按剩余时间收紧就绪门探测，防单探测冲破 wall-clock 上限。 */
  timeoutMs?: number;
}

export interface RedirectHop {
  status: number;
  location: string;
}

export interface UnlockResponse {
  /** 最终响应状态码；网络错误/超时/构造失败 = 0。 */
  status: number;
  /** 最终响应头（Electron net 头为 string[]）。 */
  headers: Record<string, string[]>;
  /** 响应体（可能被 1.5MB 上限截断）。 */
  body: string;
  /** body 是否被上限截断。 */
  truncated: boolean;
  /** 逐跳重定向链（redirect:'manual' 下每个 3xx 的 Location）。 */
  redirectChain: RedirectHop[];
  /** 非空 = 传输失败（超时 / 网络错 / 超跳）。 */
  error?: string;
  /** 传输分诊（§12.2 X1，纯诊断不入判定）：settle 时所处阶段——connect（从未收到响应，网络层拦截/RST 形态）/
   *  headers（响应头已到、body 停滞，MTU 黑洞/tarpit 形态）/ body（已收部分 body）。区分「从未连上」与「连上停滞」。 */
  phase?: 'connect' | 'headers' | 'body';
  /** 传输分诊（§12.2 X1）：settle 时已累计的响应体字节数（0=未收到 body）。 */
  bytes?: number;
}

/** 绑定到某 session 的请求函数（注入给 checker，天然可 mock 无网络）。 */
export type UnlockFetch = (req: UnlockRequest) => Promise<UnlockResponse>;

/**
 * 发一个经 session 的请求，永不 reject（失败落 status:0 + error）。
 * settled 单点收口 + 8s 超时兜底 + oversize 截断 + 手动重定向逐跳记录。
 */
export function fetchUnlock(session: Session, req: UnlockRequest): Promise<UnlockResponse> {
  const maxRedirects = req.maxRedirects ?? MAX_REDIRECTS;
  return new Promise<UnlockResponse>((resolve) => {
    let settled = false;
    let request: ClientRequest | undefined;
    const redirectChain: RedirectHop[] = [];
    // X1 传输分诊：外层跟踪当前阶段 + 已收字节，settle 时随 resolve 带出（含 8s 超时兜底路径）。
    let phase: 'connect' | 'headers' | 'body' = 'connect';
    let seenBytes = 0;

    const done = (r: {
      status: number;
      headers?: Record<string, string[]>;
      body?: string;
      truncated?: boolean;
      error?: string;
    }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: r.status,
        headers: r.headers ?? {},
        body: r.body ?? '',
        truncated: r.truncated ?? false,
        redirectChain,
        error: r.error,
        phase,
        bytes: seenBytes,
      });
    };

    // 兜底超时：net.request 在连接被静默吞掉时可能长时间不触发任何事件 → 超时后 abort + 落 timeout。
    // 默认 REQ_TIMEOUT_MS；调用方可经 req.timeoutMs 按整轮总预算收紧（issue 1，防单探测冲破 wall-clock 上限）。
    const timer = setTimeout(() => {
      try {
        request?.abort();
      } catch {
        /* ignore */
      }
      done({ status: 0, error: 'timeout' });
    }, req.timeoutMs ?? REQ_TIMEOUT_MS);

    try {
      request = net.request({
        method: req.method ?? 'GET',
        url: req.url,
        session,
        redirect: 'manual',
      });
    } catch (e) {
      done({ status: 0, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    if (req.headers) {
      for (const [k, v] of Object.entries(req.headers)) request.setHeader(k, v);
    }

    // redirect:'manual' → 每个 3xx 都 emit，必须显式 followRedirect 才继续，否则请求悬停。
    request.on('redirect', (statusCode: number, _method: string, redirectUrl: string) => {
      if (settled) return;
      redirectChain.push({ status: statusCode, location: redirectUrl });
      if (redirectChain.length > maxRedirects) {
        try {
          request?.abort();
        } catch {
          /* ignore */
        }
        done({ status: statusCode, error: 'too_many_redirects' });
        return;
      }
      try {
        request?.followRedirect();
      } catch (e) {
        // L3：followRedirect 抛出（请求已终态/被 abort）→ 先 abort 释放底层连接，再收口，避免悬挂请求。
        try {
          request?.abort();
        } catch {
          /* ignore */
        }
        done({ status: statusCode, error: e instanceof Error ? e.message : String(e) });
      }
    });

    request.on('response', (res) => {
      phase = 'headers'; // X1：响应头已到（连上了）
      const status = res.statusCode ?? 0;
      const headers = (res.headers ?? {}) as Record<string, string[]>;
      let body = '';
      let bodyBytes = 0; // N1：按字节累计（chunk.length=字节数），与 MAX_BODY_BYTES 名实一致，非 UTF-16 code unit。
      let truncated = false;
      res.on('data', (chunk: Buffer) => {
        if (settled || truncated) return;
        phase = 'body'; // X1：已收到 body 字节
        bodyBytes += chunk.length;
        seenBytes = bodyBytes;
        body += chunk.toString('utf8');
        if (bodyBytes > MAX_BODY_BYTES) {
          truncated = true;
          // 截断仅供 marker 子串匹配，无需精确字节界，按 code unit 上限裁剪足够（不影响判定正确性）。
          if (body.length > MAX_BODY_BYTES) body = body.slice(0, MAX_BODY_BYTES);
          try {
            request?.abort();
          } catch {
            /* ignore */
          }
          done({ status, headers, body, truncated: true });
        }
      });
      // 提前关闭/断连也兜底收口，防 promise 永挂。'end'=正常收尾；'error'=流式中断（electron net 文档：服务器
      // 中途断连时 response 发 'error'）。另经基类 EventEmitter 视图补挂 'aborted'/'close'（electron 的
      // IncomingMessage 类型仅声明 data/end/error，但运行时经 NodeEventEmitter 仍可能派发这些边缘事件——对齐
      // IpInfoService res.on('close') 先例，done 幂等，未触发亦无害）→ 提前断连不必空等满 8s 超时（L4）。
      res.on('end', () => done({ status, headers, body, truncated }));
      res.on('error', (err: Error) =>
        done({ status, headers, body, truncated, error: err.message })
      );
      const resEvents = res as unknown as NodeJS.EventEmitter;
      resEvents.on('aborted', () => done({ status, headers, body, truncated }));
      resEvents.on('close', () => done({ status, headers, body, truncated }));
    });

    request.on('error', (err: Error) => done({ status: 0, error: err.message }));

    if (req.method === 'POST' && req.body != null) request.write(req.body);
    request.end();
  });
}

/** 把 session 柯里化成 UnlockFetch（注入 checker / 编排器）。 */
export const makeUnlockFetch =
  (session: Session): UnlockFetch =>
  (req) =>
    fetchUnlock(session, req);
