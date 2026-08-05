/**
 * resetCoreToFactory 的出厂核完整性校验（node env，零网络）。
 *
 * 为什么这道门存在：reset 的语义是「回到已知良好的出厂状态」，是用户排障时最信任的一步。若安装目录里的
 * 出厂核已被替换（portable 安装目录用户可写，普通权限的恶意程序即可改），reset 会把恶意核**当作干净核
 * 装回去**——比不 reset 更糟。
 *
 * 为什么 macOS 必须跳过：release 流程对 .app 做 `codesign --force --deep --sign -`，深签会重写嵌套二进制
 * （真机实测：同一文件签名前后 sha 不同），而 `coreBinarySha256` pin 取自上游 release 原件。在 mac 上硬
 * 校验会对每个用户误报。此处用例把「跳过」钉成显式约定，防有人日后"顺手补齐三平台"制造全量误报。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-reset-verify-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false },
  dialog: {},
}));

// 出厂核内容固定 → 反推出 pin 塞进 mock manifest。正/负两向都不依赖 resources/ 是否已跑过 fetch:core，
// 否则「CI 上没有那个文件」会让正向断言静默空过（绿而无信息量）。
const MOCK_CORE_BYTES = 'pretend this is the bundled sing-box';
const MOCK_PIN = require('crypto').createHash('sha256').update(MOCK_CORE_BYTES).digest('hex');
jest.mock('../../../shared/core-manifest.json', () => ({
  bundledCoreVersion: '9.9.9',
  coreArchiveSha256: {},
  coreBinarySha256: { linux: MOCK_PIN, win: MOCK_PIN, 'mac-x64': MOCK_PIN, 'mac-arm64': MOCK_PIN },
}));

import { CoreUpdateService } from '../CoreUpdateService';

const REAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
afterEach(() => setPlatform(REAL_PLATFORM));
afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 写一个内容任意的假"出厂核"，返回路径与其真实 sha。 */
function fakeCore(content: string): { p: string; sha: string } {
  const p = path.join(TMP, `core-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, content);
  return { p, sha: createHash('sha256').update(content).digest('hex') };
}

const svc = () => new CoreUpdateService({ addLog: () => {} } as never);
const verify = (s: CoreUpdateService, p: string): string | null =>
  (s as unknown as { verifyFactoryCore: (x: string) => string | null }).verifyFactoryCore(p);

describe('verifyFactoryCore — 出厂核完整性', () => {
  it('win/linux + 二进制与 pin 不符 → 返回拒绝理由（不把被替换的核装回去）', () => {
    const { p } = fakeCore('tampered core bytes');
    for (const plat of ['win32', 'linux'] as const) {
      setPlatform(plat);
      const reason = verify(svc(), p);
      expect(reason).toMatch(/与官方指纹不符/);
    }
  });

  /**
   * macOS 那格必须放行：pin 与 mac 上的实际字节**本就**不同（深签重写），不是"暂时没做"。
   * 若哪天有人把 darwin 也纳入校验，本用例会红——那正是要拦的改动。
   */
  it('darwin → 恒放行（深签重写字节，pin 不适用；mac 侧由 .app 代码签名保护）', () => {
    const { p } = fakeCore('anything at all');
    setPlatform('darwin');
    expect(verify(svc(), p)).toBeNull();
  });

  it('二进制与 pin 相符 → 放行（win/linux 两平台）', () => {
    const { p } = fakeCore(MOCK_CORE_BYTES);
    for (const plat of ['win32', 'linux'] as const) {
      setPlatform(plat);
      expect(verify(svc(), p)).toBeNull();
    }
  });

  it('文件不存在 → 返回可读理由而非抛出（reset 应给出提示，不是崩）', () => {
    setPlatform('linux');
    expect(verify(svc(), path.join(TMP, 'nope'))).toMatch(/无法读取/);
  });
});
