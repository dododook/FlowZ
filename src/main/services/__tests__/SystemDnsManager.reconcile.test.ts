/**
 * SystemDnsBase.reconcileDns() 热插重灌单测。
 * - mock ../utils/paths.getUserDataPath → 临时目录，让 writeMarker/readMarker 走真实 fs（最贴近实际 marker IO）。
 * - SystemDnsBase 抽象 → concrete 测试子类 TestDns stub 全部平台原语（listTargets/readDns/applyDns/同步腿/
 *   readEffectiveResolvers），用可变 fixture 模拟「当前各服务 DNS」。
 * - jest.spyOn(applyDns) 观测重灌调用；marker 落盘后再读回校验 original（防自指 / 已消失服务保留断言）。
 * 风格参照 src/shared/__tests__/system-dns.test.ts。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// userData → 每个测试独立临时目录（beforeEach 重设），marker 真实落盘读回。
let tmpUserData: string;
jest.mock('../../utils/paths', () => ({
  getUserDataPath: () => tmpUserData,
}));

import { SystemDnsBase, type ISystemDnsManager } from '../SystemDnsManager';
import { CONTROLLED_TUN_DNS_IP } from '../../../shared/dns';
import type { SystemDnsMarker } from '../../../shared/system-dns';

const CONTROLLED = CONTROLLED_TUN_DNS_IP; // '8.8.8.8'

/**
 * concrete 测试子类：用 dnsMap（service → 当前 DNS）驱动 listTargets/readDns；applyDns 写回 dnsMap 模拟真实生效，
 * 便于「再次 reconcile 看幂等」。所有同步腿/方案B 原语给最小 stub。
 */
class TestDns extends SystemDnsBase {
  constructor(public dnsMap: Record<string, string[]>) {
    super();
  }
  protected async listTargets(): Promise<string[]> {
    return Object.keys(this.dnsMap);
  }
  protected async readDns(target: string): Promise<string[]> {
    return this.dnsMap[target] ?? [];
  }
  /** public hook：applyDns 委托给它 → 测试直接 spy 这个 public 方法（类型干净，避免 protected 的 `as never` 污染）。 */
  async applyDnsImpl(target: string, ips: string[]): Promise<void> {
    this.dnsMap[target] = [...ips]; // 模拟真实生效，供二次 reconcile 验幂等
  }
  protected async applyDns(target: string, ips: string[]): Promise<void> {
    await this.applyDnsImpl(target, ips);
  }
  protected listTargetsSync(): string[] {
    return Object.keys(this.dnsMap);
  }
  protected applyDnsSync(target: string, ips: string[]): void {
    this.dnsMap[target] = [...ips];
  }
  protected async readEffectiveResolvers(): Promise<string[]> {
    return [];
  }
}

function markerPath(): string {
  return path.join(tmpUserData, 'system-dns.marker.json');
}
function writeMarkerFile(original: Record<string, string[]>): void {
  const marker: SystemDnsMarker = { controlledIp: CONTROLLED, original, at: Date.now() };
  fs.writeFileSync(markerPath(), JSON.stringify(marker));
}
function readMarkerFile(): SystemDnsMarker | null {
  try {
    return JSON.parse(fs.readFileSync(markerPath(), 'utf-8')) as SystemDnsMarker;
  } catch {
    return null;
  }
}

beforeEach(() => {
  tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-dns-reconcile-'));
});
afterEach(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
});

describe('reconcileDns 热插重灌', () => {
  it('1. marker 不在 → 零 applyDns（接管未激活绝不擅自动手）', async () => {
    const dns = new TestDns({ 'Wi-Fi': ['192.168.5.1'] });
    const spy = jest.spyOn(dns, 'applyDnsImpl');
    await dns.reconcileDns();
    expect(spy).not.toHaveBeenCalled();
    expect(readMarkerFile()).toBeNull(); // 不创建 marker
  });

  it('2. 新增服务（比 marker.original 多、非受控）→ 被 applyDns(controlledIp)，marker.original 并入其真实原始值', async () => {
    // marker 仅记录 Wi-Fi（接管时已受控）；启动后新插 USB Ethernet 仍是 LAN DNS。
    writeMarkerFile({ 'Wi-Fi': ['192.168.5.1'] });
    const dns = new TestDns({ 'Wi-Fi': [CONTROLLED], 'USB Ethernet': ['10.0.0.1'] });
    const spy = jest.spyOn(dns, 'applyDnsImpl');

    await dns.reconcileDns();

    // 仅新增的未受控服务被接管，已受控 Wi-Fi 不动。
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('USB Ethernet', [CONTROLLED]);
    expect(dns.dnsMap['USB Ethernet']).toEqual([CONTROLLED]);
    // marker.original 并入新服务真实原始值，且保留既有 Wi-Fi 记录。
    const m = readMarkerFile()!;
    expect(m.original).toEqual({ 'Wi-Fi': ['192.168.5.1'], 'USB Ethernet': ['10.0.0.1'] });
  });

  it('3. 已受控服务（current === [controlledIp]）→ 跳过不重复 applyDns', async () => {
    writeMarkerFile({ 'Wi-Fi': ['192.168.5.1'], Ethernet: ['10.0.0.1'] });
    // Wi-Fi 已受控、Ethernet 仍未受控 → 只重灌 Ethernet。
    const dns = new TestDns({ 'Wi-Fi': [CONTROLLED], Ethernet: ['10.0.0.1'] });
    const spy = jest.spyOn(dns, 'applyDnsImpl');

    await dns.reconcileDns();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('Ethernet', [CONTROLLED]);
    expect(spy).not.toHaveBeenCalledWith('Wi-Fi', expect.anything());
  });

  it('4. 全部已受控 → 幂等 no-op（零 applyDns、不重写 marker）', async () => {
    const original = { 'Wi-Fi': ['192.168.5.1'], Ethernet: ['10.0.0.1'] };
    writeMarkerFile(original);
    const before = fs.readFileSync(markerPath(), 'utf-8'); // 原始 marker 字节快照（含 at）
    const dns = new TestDns({ 'Wi-Fi': [CONTROLLED], Ethernet: [CONTROLLED] });
    const spy = jest.spyOn(dns, 'applyDnsImpl');

    await dns.reconcileDns();

    expect(spy).not.toHaveBeenCalled();
    // marker 文件逐字节不变 → 全受控时连 marker 都不重写（at 时间戳也不变）。
    expect(fs.readFileSync(markerPath(), 'utf-8')).toBe(before);
    expect(readMarkerFile()!.original).toEqual(original);
  });

  it('5. 防自指：reconcile 后 marker 已是受控值，再 reconcile 不把 8.8.8.8 误存成 original', async () => {
    // 首轮：Wi-Fi 真实原始 192.168.5.1，未受控 → 接管。
    writeMarkerFile({ 'Wi-Fi': ['192.168.5.1'] });
    const dns = new TestDns({ 'Wi-Fi': ['192.168.5.1'] });
    await dns.reconcileDns();
    expect(dns.dnsMap['Wi-Fi']).toEqual([CONTROLLED]); // 已生效为受控

    // 二轮：Wi-Fi 当前已是受控值；若朴素采当前值会把 8.8.8.8 误存 original → 永远还原到受控 IP。
    const spy = jest.spyOn(dns, 'applyDnsImpl');
    await dns.reconcileDns();
    expect(spy).not.toHaveBeenCalled(); // 已受控 → 幂等不重灌
    // marker.original 仍是真实原始 192.168.5.1，绝不被受控 IP 污染。
    expect(readMarkerFile()!.original).toEqual({ 'Wi-Fi': ['192.168.5.1'] });
  });

  it('6. 已消失服务（marker.original 有、current 无）→ writeMarker 后 original 仍保留', async () => {
    // marker 记录 Wi-Fi(已受控) + VPN(接管时受控，启动后服务消失)。
    writeMarkerFile({ 'Wi-Fi': ['192.168.5.1'], VPN: ['172.16.0.1'] });
    // current 只剩 Wi-Fi(受控) + 新插 Ethernet(未受控)；VPN 已消失（不在 listTargets）。
    const dns = new TestDns({ 'Wi-Fi': [CONTROLLED], Ethernet: ['10.0.0.1'] });

    await dns.reconcileDns();

    const m = readMarkerFile()!;
    // 已消失的 VPN original 必须保留（mergedOriginal 以既有 marker.original 为底，computeOriginalToSave 不覆盖未出现服务）。
    expect(m.original.VPN).toEqual(['172.16.0.1']);
    expect(m.original['Wi-Fi']).toEqual(['192.168.5.1']);
    expect(m.original.Ethernet).toEqual(['10.0.0.1']); // 新增并入
  });

  it('7. 单服务 applyDns 抛错 → 不阻断其余、不抛', async () => {
    writeMarkerFile({});
    const dns = new TestDns({ Bad: ['10.0.0.1'], Good: ['10.0.0.2'] });
    const spy = jest
      .spyOn(dns, 'applyDnsImpl')
      .mockImplementation(async (target: string, ips: string[]) => {
        if (target === 'Bad') throw new Error('networksetup failed');
        dns.dnsMap[target] = [...ips];
      });

    await expect(dns.reconcileDns()).resolves.toBeUndefined(); // best-effort 绝不抛

    // 两个都尝试了；Good 成功重灌，Bad 失败但被吞。
    expect(spy).toHaveBeenCalledWith('Bad', [CONTROLLED]);
    expect(spy).toHaveBeenCalledWith('Good', [CONTROLLED]);
    expect(dns.dnsMap['Good']).toEqual([CONTROLLED]);
  });

  it('8. Win/Linux 形态（无 marker）→ no-op（任何实现只要 marker 不在都不动手）', async () => {
    // 模拟 Win/Linux：从不写 marker。即便有未受控服务，reconcile 也因 marker 不在直接返回。
    const dns = new TestDns({ Ethernet: ['10.0.0.1'] });
    const spy = jest.spyOn(dns, 'applyDnsImpl');

    const mgr: ISystemDnsManager = dns;
    await mgr.reconcileDns();

    expect(spy).not.toHaveBeenCalled();
    expect(readMarkerFile()).toBeNull();
  });
});
