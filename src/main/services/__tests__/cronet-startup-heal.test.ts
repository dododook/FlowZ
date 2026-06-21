/**
 * libcronet 启动失败自愈闭环单测（T2，docs/design/cronet-lib-self-healing.md §4.3）。
 *
 * 覆盖：
 *  - isCronetLibError：`cronet: library not found` / Windows `Place libcronet.dll ...` / dlopen 文案命中；普通错误不误命中。
 *  - classifyCoreError：cronet FATAL → ProxyErrorCode.CRONET_LIB_MISSING（结构化码，且不撞既有 connection refused 等分支）。
 *  - getCronetHealStats：默认 0/0（本会话无触发）。
 *  - 诊断报告渲染：runtime.cronetLibStatus + 自愈触发/失败计数纳入 Markdown（buildDiagnosticReport 纯函数）。
 *
 * 注：起核失败→strong 重拷→重启一次的完整闭环依赖真实 spawn（sing-box 进程），属集成/真机验证项
 * （docs §6 真机：Linux rm/truncate libcronet、Win 删 dll/只读 resources），本机仅 mock 不跑宿主进程。
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-cronet-heal-test-'));
jest.mock('electron', () => ({
  app: {
    getPath: () => TMP,
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => TMP,
  },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ProxyManager } from '../ProxyManager';
import { ProxyErrorCode } from '../../../shared/types';
import {
  buildDiagnosticReport,
  type DiagnosticReportInput,
} from '../../../shared/diagnostic-redact';

describe('T2 isCronetLibError / classifyCoreError — cronet 缺库识别', () => {
  const pm = new ProxyManager();
  const isCronet = (m: string) => (pm as any).isCronetLibError(m) as boolean;
  const classify = (m: string) => (pm as any).classifyCoreError(m) as ProxyErrorCode;

  it('命中 sing-box cronet FATAL 文案', () => {
    expect(isCronet('FATAL[0000] cronet: library not found')).toBe(true);
    expect(
      isCronet('cronet: library not found. Place libcronet.dll in the executable directory or PATH')
    ).toBe(true);
    expect(isCronet('failed to dlopen libcronet.so: no such file')).toBe(true);
  });

  it('普通错误不误命中', () => {
    expect(isCronet('connection refused')).toBe(false);
    expect(isCronet('dns lookup failed')).toBe(false);
    expect(isCronet('bind: address already in use')).toBe(false);
    expect(isCronet('library not found')).toBe(false); // 无 cronet 关键字 → 不命中
    // B 收紧：去裸 `not found` 后，名含 cronet 的 selector 报 dependency 错误不再误判为缺库（防虚触发自愈）。
    expect(isCronet('dependency[cronet] not found')).toBe(false);
  });

  it('classifyCoreError → CRONET_LIB_MISSING（优先于其它分支，不撞 connection refused 等）', () => {
    expect(classify('cronet: library not found')).toBe(ProxyErrorCode.CRONET_LIB_MISSING);
    // 与其它分支正交：普通 cronet 无关错误仍走原分类
    expect(classify('connection refused')).toBe(ProxyErrorCode.CONNECTION_REFUSED);
  });
});

describe('T2 getCronetHealStats — 会话计数', () => {
  it('全新实例默认 0/0', () => {
    const pm = new ProxyManager();
    expect(pm.getCronetHealStats()).toEqual({ triggered: 0, failed: 0 });
  });
});

describe('T2 诊断报告渲染 — cronet 状态 + 自愈计数', () => {
  function mkInput(over: Partial<DiagnosticReportInput['runtime']>): DiagnosticReportInput {
    return {
      generatedAt: '2026-06-21T00:00:00.000Z',
      app: { flowzVersion: '9.9.9', coreVersion: '1.14.0', os: 'linux x64 6.0.0' },
      runtime: {
        proxyMode: 'rule',
        proxyModeType: 'tun',
        proxyRunning: false,
        logLevel: 'info',
        captureActive: false,
        ...over,
      },
      redactedUserConfig: {},
      redactedSingboxConfig: {},
      appLogTail: '',
      singboxLogTail: '',
    };
  }

  it('cronetLibStatus 写入报告', () => {
    const md = buildDiagnosticReport(mkInput({ cronetLibStatus: 'copy-failed' }));
    expect(md).toContain('libcronet 状态：copy-failed');
  });

  it('自愈触发/失败计数（>0 时）写入报告', () => {
    const md = buildDiagnosticReport(
      mkInput({ cronetLibStatus: 'available', cronetHealTriggered: 2, cronetHealFailed: 1 })
    );
    expect(md).toContain('libcronet 自愈：触发 2 次 / 失败 1 次');
  });

  it('计数全 0 → 不渲染自愈行（保持报告精简）', () => {
    const md = buildDiagnosticReport(
      mkInput({ cronetLibStatus: 'available', cronetHealTriggered: 0, cronetHealFailed: 0 })
    );
    expect(md).not.toContain('libcronet 自愈：');
    // 但状态行仍在
    expect(md).toContain('libcronet 状态：available');
  });
});

afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
