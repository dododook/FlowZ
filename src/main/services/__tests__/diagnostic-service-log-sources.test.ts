/**
 * DiagnosticService 的日志取数单测：守住「报告里三段日志各读各的文件」这条路径收口。
 *
 * 为什么必须有：`paths.ts` 的 `getSingBoxStartupLogPath()` 注释声明「诊断报告与写侧共用本函数，杜绝两边
 * 路径漂移」，但在此之前这条声明只由 grep 保证——把 `getSingBoxStartupLogPath()` 误写成 `getSingBoxLogPath()`
 * 全套测试照样绿（报告只是把 singbox.log 渲染两遍，两个标题都在），`Promise.all` 三元组顺序错位同理无人拦。
 *
 * 只桩 IO 与协作对象，不碰真实文件系统、不碰宿主网络。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-diagsvc-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { DiagnosticService } from '../DiagnosticService';
import { withPlatformAsync } from './platform-test-utils';
import {
  getLogsPath,
  getSingBoxLogPath,
  getSingBoxStartupLogPath,
  getWindowsWatchdogLogPath,
} from '../../utils/paths';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** B0 汇总行样本：既做桩返回值，也做报告文本断言的靶。 */
const TIMELINE_LINE = '起核阶段耗时 total=1234ms outcome=ok | killOrphans=181 startTail=44';

function makeSvc(opts: { startedViaHelper?: boolean; lastDnsFlush?: unknown } = {}): any {
  const configManager: any = { loadConfig: jest.fn().mockResolvedValue({ logLevel: 'info' }) };
  const logManager: any = { flush: jest.fn().mockResolvedValue(undefined) };
  const proxyManager: any = {
    getCoreVersion: jest.fn().mockResolvedValue('1.14.0-beta.2'),
    getStatus: jest.fn().mockReturnValue({ running: false }),
    isStartedViaHelper: jest.fn().mockReturnValue(!!opts.startedViaHelper),
    generateSingBoxConfig: jest.fn().mockReturnValue({ log: { level: 'info' } }),
    getCronetHealStats: jest.fn().mockReturnValue({ triggered: 0, failed: 0 }),
    getLastStartReadyRetries: jest.fn().mockReturnValue(0),
    // issue #367：诊断报告读取最近一次 DNS 缓存刷新结果；null=本会话从未触发（多数用例不覆盖该段内容）。
    getLastDnsFlush: jest.fn().mockReturnValue(opts.lastDnsFlush ?? null),
    // 返回真串而非 null：桩返 null 时渲染分支恒不进入 ⇒ 这个桩**结构上不可能有检出力**，
    // 删掉 DiagnosticService 里那行接线也照样绿（复审 M10b 实测）。下方 describe 用它钉住接线。
    getLastStartTimeline: jest.fn().mockReturnValue(TIMELINE_LINE),
  };
  const systemProxyManager: any = { getProxyStatus: jest.fn().mockResolvedValue(null) };
  return new DiagnosticService(configManager, logManager, proxyManager, systemProxyManager) as any;
}

/**
 * 本文件的断言与 `process.platform` 强相关（Windows 会多收一段看护脚本日志），故每条用例都**显式 pin
 * 平台**，绝不吃宿主平台的默认值——否则本地 Linux 全绿、Windows CI runner 上必挂（已实际踩过）。
 */

describe('DiagnosticService — 日志取数路径收口', () => {
  it('三段日志各读各的文件，startup log 走 getSingBoxStartupLogPath()（不与 singbox.log 同源）', async () => {
    // pin 非 Windows：Windows 会多收一段看护脚本日志，seen 就不是三条了
    const { seen, md } = await withPlatformAsync('linux', async () => {
      const svc = makeSvc();
      const seen: string[] = [];
      jest.spyOn(svc, 'readTail').mockImplementation(async (...args: unknown[]) => {
        const p = args[0] as string;
        seen.push(p);
        return `tail-of:${path.basename(p)}`;
      });
      return { seen, md: (await svc.buildReport()) as string };
    });

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3); // 三个互不相同 → 排除「两段读同一文件」的漂移
    expect(seen[0]).toBe(path.join(getLogsPath(), 'app.log'));
    expect(seen[1]).toBe(getSingBoxLogPath());
    expect(seen[2]).toBe(getSingBoxStartupLogPath());
    // 顺序错位（把 singboxLogTail 与 startupLogTail 调换）会被下面两条钉住
    expect(md).toMatch(/## singbox\.log（近期）[\s\S]*tail-of:singbox\.log/);
    expect(md).toMatch(/## singbox_startup\.log[\s\S]*tail-of:singbox_startup\.log/);
  });

  it('Windows UAC 路径：startup 段标注核 stderr，并额外收看护脚本自述日志', async () => {
    const { seen, md } = await withPlatformAsync('win32', async () => {
      const svc = makeSvc({ startedViaHelper: false });
      const seen: string[] = [];
      jest.spyOn(svc, 'readTail').mockImplementation(async (...args: unknown[]) => {
        const p = args[0] as string;
        seen.push(p);
        return `tail-of:${path.basename(p)}`;
      });
      return { seen, md: (await svc.buildReport()) as string };
    });
    expect(md).toContain('写侧 UAC 看护脚本');
    expect(md).toContain('核 stderr');
    // 看护自述日志是「谁停的核」的判据，与 FATAL 互补，Windows 上必须一并收
    expect(seen).toContain(getWindowsWatchdogLogPath());
    expect(md).toContain('## flowz-win-watchdog.log');
    expect(md).toContain('tail-of:flowz-win-watchdog.log');
  });

  it('非 Windows 不出看护脚本日志段（避免恒定的「(无日志文件)」噪声）', async () => {
    const { seen, md } = await withPlatformAsync('linux', async () => {
      const svc = makeSvc({ startedViaHelper: true });
      const seen: string[] = [];
      jest.spyOn(svc, 'readTail').mockImplementation(async (...args: unknown[]) => {
        seen.push(args[0] as string);
        return 'x';
      });
      return { seen, md: (await svc.buildReport()) as string };
    });
    expect(seen).not.toContain(getWindowsWatchdogLogPath());
    expect(md).not.toContain('## flowz-win-watchdog.log');
  });

  it('helper 路径标注为含核 stdout+stderr 且只追加不截断', async () => {
    const md = await withPlatformAsync('linux', async () => {
      const svc = makeSvc({ startedViaHelper: true });
      jest.spyOn(svc, 'readTail').mockResolvedValue('FATAL[0000] boom');
      return (await svc.buildReport()) as string;
    });
    expect(md).toContain('核 stdout+stderr');
    expect(md).toContain('只追加不截断');
  });
});

/**
 * lastDnsFlush 的**接线**层（ProxyManager 结果 → 报告字段）单测。
 * 渲染分支本身在 diagnostic-redact.test.ts 有测，但那里是直接手灌字段——接线漏抄某个 optional 字段时
 * tsc 不报、渲染测试全绿，而生产链路里那条分支永远走不到（本轮实测：partial 漏抄 → macOS 部分成功印成「成功」）。
 */
describe('DiagnosticService — lastDnsFlush 字段接线', () => {
  const base = {
    ok: true,
    detail: 'helper root（dscacheutil 已成功，HUP mDNSResponder 失败）',
    context: 'start' as const,
    at: Date.now(),
  };

  it('partial 透传：部分成功不得在报告里印成「成功」', async () => {
    const md = await withPlatformAsync('linux', async () => {
      const svc = makeSvc({ lastDnsFlush: { ...base, partial: 'killall-hup exit status 1' } });
      jest.spyOn(svc, 'readTail').mockResolvedValue('');
      return (await svc.buildReport()) as string;
    });
    expect(md).toContain('部分成功');
    expect(md).toContain('killall-hup exit status 1');
  });

  it('reason / skipped 同样透传（同一处映射漏抄的其余字段）', async () => {
    const md = await withPlatformAsync('linux', async () => {
      const svc = makeSvc({
        lastDnsFlush: {
          ok: false,
          reason: 'permission-denied',
          detail: 'polkit 拒绝',
          context: 'link-change',
          at: Date.now(),
        },
      });
      jest.spyOn(svc, 'readTail').mockResolvedValue('');
      return (await svc.buildReport()) as string;
    });
    expect(md).toContain('permission-denied');
    expect(md).toContain('link-change');

    const skippedMd = await withPlatformAsync('linux', async () => {
      const svc = makeSvc({
        lastDnsFlush: {
          ok: true,
          skipped: true,
          detail: '平台 freebsd 无 DNS 缓存刷新机制，已跳过',
          context: 'start',
          at: Date.now(),
        },
      });
      jest.spyOn(svc, 'readTail').mockResolvedValue('');
      return (await svc.buildReport()) as string;
    });
    expect(skippedMd).toContain('已跳过');
  });
});

/**
 * B0 接线：`getLastStartTimeline()` 的返回值必须真的进报告。这条链路的另一半（渲染）由
 * `src/shared/__tests__/diagnostic-redact.test.ts` 守；此处守 service → 报告这一跳。
 */
describe('DiagnosticService — 起核阶段耗时汇总行接线（B0）', () => {
  it('汇总行出现在报告里', async () => {
    const md = await withPlatformAsync('linux', async () => {
      const svc = makeSvc();
      jest.spyOn(svc, 'readTail').mockResolvedValue('x');
      return (await svc.buildReport()) as string;
    });
    // 变异守卫：删掉 DiagnosticService 里 `lastStartTimeline: …` 那行 → 红
    expect(md).toContain(TIMELINE_LINE);
  });

  it('从未启动过（返回 null）→ 报告不出现该段，也不出现占位符', async () => {
    const md = await withPlatformAsync('linux', async () => {
      const svc = makeSvc();
      svc.proxyManager.getLastStartTimeline = jest.fn().mockReturnValue(null);
      jest.spyOn(svc, 'readTail').mockResolvedValue('x');
      return (await svc.buildReport()) as string;
    });
    expect(md).not.toContain('起核阶段耗时');
  });
});
