/**
 * 出口伴测 runner 纯逻辑单测：单飞 / 节流（手动 bypass）/ 守卫①空返 / rtt null 不 publish / 双点不一致丢弃 /
 * 成功 publish 一次且推进 lastAt / measure 抛异常不外泄 / publish 入参恒为正（绝不 -1）。
 */
import {
  createExitProbeLatencyRunner,
  type ExitProbeLatencyDeps,
  type ExitProbeTarget,
} from '../exit-probe-latency';

const EXIT: ExitProbeTarget = { serverId: 'srv-a', probeProxyPort: 5000 };

function makeDeps(over: Partial<ExitProbeLatencyDeps> = {}) {
  const publish = jest.fn();
  const measureWarmRtt = jest.fn<Promise<number | null>, [number]>().mockResolvedValue(42);
  const getSelectedExit = jest.fn<ExitProbeTarget | null, []>().mockReturnValue(EXIT);
  const deps: ExitProbeLatencyDeps = { getSelectedExit, measureWarmRtt, publish, ...over };
  return { deps, publish, measureWarmRtt, getSelectedExit };
}

describe('createExitProbeLatencyRunner', () => {
  it('守卫①空返（getSelectedExit=null）→ 不测不 publish', async () => {
    const { deps, publish, measureWarmRtt } = makeDeps({ getSelectedExit: () => null });
    const run = createExitProbeLatencyRunner(deps);
    await run({ manual: false });
    expect(measureWarmRtt).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('成功 → publish 一次（serverId + 正延迟）且推进 lastAt（下次被动触发被节流跳过）', async () => {
    let clock = 1_000_000;
    const { deps, publish, measureWarmRtt } = makeDeps();
    const run = createExitProbeLatencyRunner(deps, { minIntervalMs: 30_000, now: () => clock });
    await run({ manual: false });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('srv-a', 42);
    // 节流窗口内第二次被动触发 → 跳过（不再测）
    clock += 10_000;
    await run({ manual: false });
    expect(measureWarmRtt).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    // 超出窗口 → 恢复
    clock += 25_000;
    await run({ manual: false });
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('手动重探 bypass 节流：窗口内 manual=true 仍测', async () => {
    let clock = 1_000_000;
    const { deps, publish } = makeDeps();
    const run = createExitProbeLatencyRunner(deps, { minIntervalMs: 30_000, now: () => clock });
    await run({ manual: false });
    clock += 5_000; // 远小于 30s
    await run({ manual: true });
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('rtt=null → 不 publish、不推进 lastAt（下次可立即重试）', async () => {
    let clock = 1_000_000;
    const measureWarmRtt = jest
      .fn<Promise<number | null>, [number]>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(88);
    const { deps, publish } = makeDeps({ measureWarmRtt });
    const run = createExitProbeLatencyRunner(deps, { minIntervalMs: 30_000, now: () => clock });
    await run({ manual: false });
    expect(publish).not.toHaveBeenCalled();
    // 失败未占节流额度 → 紧接着（窗口内）被动触发应重试并成功
    clock += 1_000;
    await run({ manual: false });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('srv-a', 88);
  });

  it('双点守卫：测量期间切走（serverId 变）→ 丢弃不 publish', async () => {
    const getSelectedExit = jest
      .fn<ExitProbeTarget | null, []>()
      .mockReturnValueOnce(EXIT) // 守卫①
      .mockReturnValueOnce({ serverId: 'srv-b', probeProxyPort: 6000 }); // 守卫②：已切走
    const { deps, publish } = makeDeps({ getSelectedExit });
    const run = createExitProbeLatencyRunner(deps);
    await run({ manual: false });
    expect(publish).not.toHaveBeenCalled();
  });

  it('双点守卫：测量后出口消失（getSelectedExit=null）→ 丢弃', async () => {
    const getSelectedExit = jest
      .fn<ExitProbeTarget | null, []>()
      .mockReturnValueOnce(EXIT)
      .mockReturnValueOnce(null);
    const { deps, publish } = makeDeps({ getSelectedExit });
    const run = createExitProbeLatencyRunner(deps);
    await run({ manual: false });
    expect(publish).not.toHaveBeenCalled();
  });

  it('单飞：在飞期间的并发触发直接返回（只测一次）', async () => {
    let resolve!: (v: number | null) => void;
    const measureWarmRtt = jest
      .fn<Promise<number | null>, [number]>()
      .mockImplementation(() => new Promise((r) => (resolve = r)));
    const { deps, publish } = makeDeps({ measureWarmRtt });
    const run = createExitProbeLatencyRunner(deps);
    const p1 = run({ manual: false }); // 进入在飞
    await run({ manual: false }); // 并发：应被单飞挡下
    expect(measureWarmRtt).toHaveBeenCalledTimes(1);
    resolve(50);
    await p1;
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('measure 抛异常 → 静默不外泄、不 publish、可再次触发', async () => {
    const measureWarmRtt = jest
      .fn<Promise<number | null>, [number]>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(30);
    const { deps, publish } = makeDeps({ measureWarmRtt });
    const run = createExitProbeLatencyRunner(deps, { minIntervalMs: 0 });
    await expect(run({ manual: false })).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
    // 异常后 inFlight 已复位 → 再次触发正常
    await run({ manual: false });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('守卫①抛异常 → 静默不外泄、不 publish、未置 inFlight 可再触发', async () => {
    let throwOnce = true;
    const getSelectedExit = jest.fn<ExitProbeTarget | null, []>().mockImplementation(() => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error('boom');
      }
      return EXIT;
    });
    const { deps, publish, measureWarmRtt } = makeDeps({ getSelectedExit });
    const run = createExitProbeLatencyRunner(deps);
    await expect(run({ manual: false })).resolves.toBeUndefined();
    expect(measureWarmRtt).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    // 异常发生在置 inFlight 之前 → 未卡死，再次触发正常
    await run({ manual: false });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('publish 入参恒为正延迟（伴测路径绝不产生 -1）', async () => {
    const { deps, publish } = makeDeps();
    const run = createExitProbeLatencyRunner(deps);
    await run({ manual: false });
    const arg = publish.mock.calls[0][1];
    expect(arg).toBeGreaterThan(0);
  });

  // Y2（§12.3.2 / P8-GAP④）：在飞期被吞的触发不再丢弃，settle 后补跑一次（走完整守卫链）——治「快切到新出口的唯一
  // probe-success 撞上上一节点在飞测量被吞后恒无值」。flush 用 setImmediate 放行补跑的微任务链。
  const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

  it('Y2：在飞期被吞的触发 settle 后补跑一次（未节流时真的重测）', async () => {
    let resolve1!: (v: number | null) => void;
    const measureWarmRtt = jest
      .fn<Promise<number | null>, [number]>()
      .mockImplementationOnce(() => new Promise((r) => (resolve1 = r)))
      .mockResolvedValueOnce(60);
    const { deps, publish } = makeDeps({ measureWarmRtt });
    const run = createExitProbeLatencyRunner(deps, { minIntervalMs: 0 }); // 无节流 → 补跑可观测
    const p1 = run({ manual: false }); // 进在飞
    await run({ manual: false }); // 在飞期触发 → 记录 pending（不丢弃）
    expect(measureWarmRtt).toHaveBeenCalledTimes(1);
    resolve1(50);
    await p1;
    await flush(); // 放行 settle 后的补跑
    expect(measureWarmRtt).toHaveBeenCalledTimes(2); // 补跑 = 第二次测量
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('Y2：在飞期多次触发只补跑一次（保留最新，不连环补测）', async () => {
    let resolve1!: (v: number | null) => void;
    const measureWarmRtt = jest
      .fn<Promise<number | null>, [number]>()
      .mockImplementationOnce(() => new Promise((r) => (resolve1 = r)))
      .mockResolvedValue(70);
    const { deps } = makeDeps({ measureWarmRtt });
    const run = createExitProbeLatencyRunner(deps, { minIntervalMs: 0 });
    const p1 = run({ manual: false });
    await run({ manual: false }); // 在飞期触发 #1
    await run({ manual: false }); // 在飞期触发 #2（合并，仍只留一个 pending）
    resolve1(50);
    await p1;
    await flush();
    expect(measureWarmRtt).toHaveBeenCalledTimes(2); // p1 + 恰一次补跑（非 3 次连环）
  });

  it('Y2：在飞期 manual 触发被合并 → 补跑 bypass 节流（manual OR）', async () => {
    const clock = 1_000_000;
    let resolve1!: (v: number | null) => void;
    const measureWarmRtt = jest
      .fn<Promise<number | null>, [number]>()
      .mockImplementationOnce(() => new Promise((r) => (resolve1 = r)))
      .mockResolvedValue(80);
    const { deps } = makeDeps({ measureWarmRtt });
    // 固定时钟 + 30s 节流：非 manual 补跑会被节流拦下（lastAt=clock）；合并了 manual → bypass → 第二次测量发生。
    const run = createExitProbeLatencyRunner(deps, { minIntervalMs: 30_000, now: () => clock });
    const p1 = run({ manual: false });
    await run({ manual: true }); // 在飞期 manual 触发 → 合并 manual=true
    resolve1(50);
    await p1;
    await flush();
    expect(measureWarmRtt).toHaveBeenCalledTimes(2); // manual 未合并则补跑被节流→只 1 次；此断言证明 OR 合并
  });
});
