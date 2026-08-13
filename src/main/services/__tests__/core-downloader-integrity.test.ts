/**
 * CoreDownloader.downloadFile 的**内容完整性**校验（node env，零网络）：mock electron `net.request`，
 * 用 EventEmitter 驱动 response/data/end 流（照 unlock-http.test.ts 的 electron mock 范式）。
 *
 * 为什么这道门必须有测试：运行期换核在下载失败时会**回落 gh-proxy 第三方镜像**，而原先的完整性检查只有
 * Content-Length —— 它能挡截断，挡不住「长度一样但内容被换」。摘要取自 api.github.com 直连响应、不经镜像，
 * 是镜像投毒的唯一实际拦截点。校验一旦被改坏，症状是**静默安装了一个不是官方发布的可执行文件**，
 * 没有任何用户可见的报错，正是最需要用例钉住的那类失败。
 */
import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockRequest = jest.fn();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-core-dl-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP },
  net: { request: (...a: unknown[]) => mockRequest(...a) },
  session: { fromPartition: () => ({ setProxy: async () => undefined }) },
}));

import { CoreDownloader } from '../core-downloader';

class FakeReq extends EventEmitter {
  setHeader(): void {}
  end(): void {}
  abort(): void {}
}

class FakeRes extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
}

const BODY = Buffer.from('fake sing-box archive bytes');
const BODY_SHA = createHash('sha256').update(BODY).digest('hex');

/** 每次 net.request 都回同一份 BODY（含正确 Content-Length，故截断检查恒过——只留摘要这一道门）。 */
function serveBody(): void {
  mockRequest.mockImplementation(() => {
    const req = new FakeReq();
    setImmediate(() => {
      const res = new FakeRes();
      res.headers['content-length'] = String(BODY.length);
      req.emit('response', res);
      setImmediate(() => {
        res.emit('data', BODY);
        res.emit('end');
      });
    });
    return req;
  });
}

const logManager = { addLog: () => {} } as never;
const newDownloader = () => new CoreDownloader(logManager, async () => null);

afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  mockRequest.mockReset();
  serveBody();
});

describe('CoreDownloader.downloadFile — sha256 完整性校验', () => {
  it('摘要相符 → 落临时文件并返回其路径（内容逐字节一致）', async () => {
    const p = await newDownloader().downloadFile(
      'https://example.com/core.tar.gz',
      false,
      BODY_SHA
    );
    expect(fs.readFileSync(p)).toEqual(BODY);
  });

  /**
   * 核心断言：长度对得上、但内容不是期望的那份 → **必须 reject**。这正是镜像投毒的形态
   * （Content-Length 检查在此恒通过），reject 掉才能保证不进入解压/预检/落位链路。
   */
  it('摘要不符 → reject 且不留下临时文件（拒装被掉包的内核）', async () => {
    const wrong = 'b'.repeat(64);
    const before = fs.readdirSync(TMP).length;
    await expect(
      newDownloader().downloadFile('https://example.com/core.tar.gz', false, wrong)
    ).rejects.toThrow(/完整性校验失败/);
    // 半成品已清，不会被后续流程捡去用。
    // **这条曾是时序相关的**：清理与 reject 原先并发发起（`file.close(); fs.unlink(tempPath, () => {}); … reject(err)`），
    // 于是「promise 落定时临时文件已不在」只是大概率成立 —— macOS CI 实测判红过（Expected: 1 / Received: 2），
    // Linux 上几乎总能侥幸通过。修法是把清理串成 close → unlink → 落定（见 core-downloader.ts handleError）。
    // 那个修复不只是为了让本条稳定：旧写法 `file.close()` 不等回调就 unlink，而 **Windows 对仍持有打开句柄的
    // 文件 unlink 会失败（EBUSY/EPERM）**，半成品会被永久留下 —— 正是本条声称要防的东西。
    // 如实记：想再加一条「unlink 回调必须先于 promise 落定」的顺序断言，但 `fs.unlink` 在现代 Node 上
    // 不可 redefine（`jest.spyOn` 抛 Cannot redefine property），做不出来，故不留一个实现不了的门。
    expect(fs.readdirSync(TMP).length).toBe(before);
  });

  /**
   * 镜像重试腿也必须带着摘要：否则「直连失败 → 换镜像」这一步会退化成不校验，
   * 而镜像恰恰是最不可信的那一环。这里让 GitHub 域名的首发失败，观察重试那次仍被摘要拦下。
   */
  it('GitHub 直连失败 → 换镜像重试，重试结果同样过摘要校验（不因重试而降级）', async () => {
    let call = 0;
    mockRequest.mockImplementation(() => {
      call++;
      const req = new FakeReq();
      if (call === 1) {
        setImmediate(() => req.emit('error', new Error('boom')));
        return req;
      }
      setImmediate(() => {
        const res = new FakeRes();
        res.headers['content-length'] = String(BODY.length);
        req.emit('response', res);
        setImmediate(() => {
          res.emit('data', BODY);
          res.emit('end');
        });
      });
      return req;
    });
    await expect(
      newDownloader().downloadFile('https://github.com/x/core.tar.gz', false, 'c'.repeat(64))
    ).rejects.toThrow(/完整性校验失败/);
    expect(call).toBe(2); // 确实重试了；且重试那次没有绕过校验
  });

  /**
   * 回归：临时文件名曾只用 `Date.now()`，而镜像重试紧跟首发失败、常落在同一毫秒 → 两次用同一路径，
   * 首发 handleError 里的异步 unlink 会删掉重试刚写好的文件（macOS CI 实测命中，Windows 侥幸躲过）。
   * 这里把两次下载压在同一毫秒内发起，断言各自拿到不同路径且内容都在。
   */
  it('同一毫秒内的并发下载 → 临时文件不撞名（含随机段）', async () => {
    const d = newDownloader();
    const [p1, p2] = await Promise.all([
      d.downloadFile('https://example.com/a.tar.gz', false, BODY_SHA),
      d.downloadFile('https://example.com/b.tar.gz', false, BODY_SHA),
    ]);
    expect(p1).not.toBe(p2);
    expect(fs.readFileSync(p1)).toEqual(BODY);
    expect(fs.readFileSync(p2)).toEqual(BODY);
  });

  /** 未传摘要时保持原行为（仅长度校验）——服务层已 fail-closed，此处只锁「不误伤既有调用形态」。 */
  it('未传摘要 → 不做内容校验（向后兼容，服务层负责拒绝无摘要的更新）', async () => {
    const p = await newDownloader().downloadFile('https://example.com/core.tar.gz');
    expect(fs.readFileSync(p)).toEqual(BODY);
  });
});
