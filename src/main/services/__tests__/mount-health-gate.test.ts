/**
 * mount-health-gate 纯状态机单测（GAP-1a）。钉住关键分支：竞态保护、reload 后自动重武装、二次超时终局、
 * finalized 停用。运行期计时器/reload/错误页副作用由真机验，此处只验决策。
 */
import { reduceMountGate, initialMountGateState, type MountGateState } from '../mount-health-gate';

describe('reduceMountGate', () => {
  const init = initialMountGateState();

  it('初始态：未 ready / 未 reload / 未 finalize / 未 reloading', () => {
    expect(init).toEqual({ ready: false, reloaded: false, finalized: false, reloading: false });
  });

  it('loadFinished（未 ready）→ arm', () => {
    const { state, action } = reduceMountGate(init, 'loadFinished');
    expect(action).toBe('arm');
    expect(state).toEqual(init); // arm 不改状态
  });

  it('rendererReady → clear + ready=true', () => {
    const { state, action } = reduceMountGate(init, 'rendererReady');
    expect(action).toBe('clear');
    expect(state.ready).toBe(true);
  });

  it('竞态保护：ready 后再来 loadFinished → none（不武装永不清除的计时器）', () => {
    const ready: MountGateState = { ...init, ready: true };
    const { action } = reduceMountGate(ready, 'loadFinished');
    expect(action).toBe('none');
  });

  it('首次 timeout（未 reload）→ reload + reloaded=true + reloading=true', () => {
    const { state, action } = reduceMountGate(init, 'timeout');
    expect(action).toBe('reload');
    expect(state.reloaded).toBe(true);
    expect(state.reloading).toBe(true);
    expect(state.finalized).toBe(false);
  });

  it('L1 不变量：reload 在途，pre-reload 陈旧 rendererReady 被丢弃（不置 ready）', () => {
    const inFlight: MountGateState = { ...init, reloaded: true, reloading: true };
    const { state, action } = reduceMountGate(inFlight, 'rendererReady');
    expect(action).toBe('none');
    expect(state.ready).toBe(false); // 陈旧 ready 不生效 → 重载页不会被判「已 ready」而失明
  });

  it('L1 不变量：reload 后重载页 loadFinished 无条件重武装并清 reloading', () => {
    const inFlight: MountGateState = { ...init, reloaded: true, reloading: true };
    const { state, action } = reduceMountGate(inFlight, 'loadFinished');
    expect(action).toBe('arm');
    expect(state.reloading).toBe(false);
  });

  it('二次 timeout（已 reload，reloading 已清）→ fatal + finalized=true', () => {
    const afterReload: MountGateState = { ...init, reloaded: true };
    const { state, action } = reduceMountGate(afterReload, 'timeout');
    expect(action).toBe('fatal');
    expect(state.finalized).toBe(true);
  });

  it('timeout 时若已 ready → none（安全网）', () => {
    const ready: MountGateState = { ...init, ready: true };
    expect(reduceMountGate(ready, 'timeout').action).toBe('none');
  });

  it('finalized 后一切事件 → none（防静态错误页 did-finish-load 再武装致 loadURL 死循环）', () => {
    const done: MountGateState = {
      ready: false,
      reloaded: true,
      finalized: true,
      reloading: false,
    };
    for (const ev of ['loadFinished', 'rendererReady', 'timeout'] as const) {
      expect(reduceMountGate(done, ev).action).toBe('none');
    }
  });

  it('happy path：loadFinished→arm, rendererReady→clear', () => {
    let s = init;
    let r = reduceMountGate(s, 'loadFinished');
    expect(r.action).toBe('arm');
    s = r.state;
    r = reduceMountGate(s, 'rendererReady');
    expect(r.action).toBe('clear');
    expect(r.state.ready).toBe(true);
  });

  it('failure path（穿线状态）：loadFinished(arm) → timeout(reload) → loadFinished(arm,清 reloading) → timeout(fatal)', () => {
    let s = init;
    let r = reduceMountGate(s, 'loadFinished');
    expect(r.action).toBe('arm');
    s = r.state;
    r = reduceMountGate(s, 'timeout');
    expect(r.action).toBe('reload');
    s = r.state; // { reloaded:true, reloading:true }
    r = reduceMountGate(s, 'loadFinished'); // 重载页到达：arm + 清 reloading
    expect(r.action).toBe('arm');
    expect(r.state.reloading).toBe(false);
    s = r.state;
    r = reduceMountGate(s, 'timeout');
    expect(r.action).toBe('fatal');
    expect(r.state.finalized).toBe(true);
  });
});
