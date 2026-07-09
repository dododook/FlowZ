/**
 * SpeedTestService.testAllServers 覆盖感知并发编排单测（纯逻辑，doTestAllServers 打桩，无网络/无 sing-box）。
 * 多入口并发（首页/托盘/页级全部/本组/单节点各传不同 serverIds 子集）：
 *   覆盖态（在飞集 ⊇ 请求）→ 复用同一次、零重跑；未覆盖 → 串行链在其后、各自用自身 set 完整测到（杜绝静默漏测/错测）。
 */
import { SpeedTestService } from '../SpeedTestService';

const mockLog = { addLog: () => {} } as unknown as ConstructorParameters<
  typeof SpeedTestService
>[0];
const srv = (id: string) => ({ id, protocol: 'vmess', address: '1.2.3.4', port: 1 }) as never;
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeSvc() {
  const svc = new SpeedTestService(mockLog);
  const calls: string[][] = [];
  const deferreds: Array<(m: Map<string, number | null>) => void> = [];
  // 打桩私有 doTestAllServers：记录每次实际测的 id 集 + 交出 resolve 手柄以精确编排时序。
  (svc as unknown as { doTestAllServers: unknown }).doTestAllServers = (
    servers: Array<{ id: string }>
  ) => {
    calls.push(servers.map((s) => s.id));
    return new Promise<Map<string, number | null>>((resolve) => deferreds.push(resolve));
  };
  return { svc, calls, deferreds };
}

describe('SpeedTestService.testAllServers 覆盖感知并发编排', () => {
  it('覆盖态复用：子集请求撞全量在飞 → 只跑一次，两者拿同一份结果', async () => {
    const { svc, calls, deferreds } = makeSvc();
    const pAll = svc.testAllServers([srv('a'), srv('b'), srv('c')]);
    const pSub = svc.testAllServers([srv('b')]); // b ⊆ {a,b,c}
    expect(calls.length).toBe(1); // 复用，未起第二次临时 sing-box
    deferreds[0](
      new Map([
        ['a', 10],
        ['b', 20],
        ['c', 30],
      ])
    );
    const all = await pAll;
    const sub = await pSub;
    expect(all).toEqual(
      new Map([
        ['a', 10],
        ['b', 20],
        ['c', 30],
      ])
    );
    expect(sub).toBe(all); // 同一份 Map 引用
  });

  it('未覆盖串行：不同分组连续 → 串行两跑，B 用自身 set、拿自身结果（非 A 的）', async () => {
    const { svc, calls, deferreds } = makeSvc();
    const pA = svc.testAllServers([srv('a1'), srv('a2')]);
    const pB = svc.testAllServers([srv('b1')]); // b1 ⊄ {a1,a2}
    expect(calls.length).toBe(1); // B 排队，A 独占（不并发双 sing-box）
    deferreds[0](
      new Map([
        ['a1', 10],
        ['a2', 20],
      ])
    );
    await pA;
    await flush(); // 串行链推进到 B
    expect(calls.length).toBe(2); // A 完 → B 起
    expect(calls[1]).toEqual(['b1']); // B 用自身 set（非复用 A 的 {a1,a2}）
    deferreds[1](new Map([['b1', 30]]));
    expect(await pB).toEqual(new Map([['b1', 30]])); // B 拿自身结果，杜绝旧「无条件复用→拿 A 结果」错测
  });

  it('子集先-全量后：串行，全量测自身全集（旧实现只会拿到 {a}、静默漏测 b/c）', async () => {
    const { svc, calls, deferreds } = makeSvc();
    const pSub = svc.testAllServers([srv('a')]);
    const pAll = svc.testAllServers([srv('a'), srv('b'), srv('c')]); // ⊄ {a}
    expect(calls.length).toBe(1);
    deferreds[0](new Map([['a', 10]]));
    await pSub;
    await flush();
    expect(calls.length).toBe(2);
    expect(calls[1].slice().sort()).toEqual(['a', 'b', 'c']); // 全量测全集，非只 a
    deferreds[1](
      new Map([
        ['a', 11],
        ['b', 20],
        ['c', 30],
      ])
    );
    expect(await pAll).toEqual(
      new Map([
        ['a', 11],
        ['b', 20],
        ['c', 30],
      ])
    );
  });

  it('串行链结束后归零：可再次立即发起全新测速（非排队）', async () => {
    const { svc, calls, deferreds } = makeSvc();
    const p1 = svc.testAllServers([srv('a')]);
    deferreds[0](new Map([['a', 10]]));
    await p1;
    await flush();
    const p2 = svc.testAllServers([srv('a')]); // 无在飞 → 立即跑
    expect(calls.length).toBe(2);
    deferreds[1](new Map([['a', 12]]));
    expect(await p2).toEqual(new Map([['a', 12]]));
  });
});
