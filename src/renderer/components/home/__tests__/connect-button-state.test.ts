/**
 * 连接圆钮三态推导单测：相位（starting/stopping）优先 → 已连 → 错误 → 未连；置灰仅约束 start/error，stop 恒可点。
 * 已连优先于错误：核在跑时残留 proxyError 也须显「停止」，不能显橘「!」却在点击时执行停止（自相矛盾）。
 */
import { deriveConnectButtonState, type ConnectButtonInputs } from '../connect-button-state';

const base: ConnectButtonInputs = {
  proxyPhase: 'idle',
  isConnected: false,
  hasError: false,
  isServerConfigured: true,
};

describe('deriveConnectButtonState', () => {
  it('starting → spinner + busy + disabled', () => {
    expect(deriveConnectButtonState({ ...base, proxyPhase: 'starting' })).toEqual({
      kind: 'starting',
      busy: true,
      disabled: true,
    });
  });

  it('stopping → spinner + busy + disabled（即便已连）', () => {
    expect(
      deriveConnectButtonState({ ...base, proxyPhase: 'stopping', isConnected: true })
    ).toEqual({ kind: 'stopping', busy: true, disabled: true });
  });

  it('相位优先于错误 / 已连', () => {
    expect(
      deriveConnectButtonState({
        ...base,
        proxyPhase: 'starting',
        hasError: true,
        isConnected: true,
      }).kind
    ).toBe('starting');
  });

  it('错误 + 已配置 → error 可点（重试）', () => {
    expect(deriveConnectButtonState({ ...base, hasError: true })).toEqual({
      kind: 'error',
      busy: false,
      disabled: false,
    });
  });

  it('错误 + 未配置 → error 置灰', () => {
    expect(
      deriveConnectButtonState({ ...base, hasError: true, isServerConfigured: false }).disabled
    ).toBe(true);
  });

  it('已连接 → stop 恒可点（不受配置完整性约束）', () => {
    expect(
      deriveConnectButtonState({ ...base, isConnected: true, isServerConfigured: false })
    ).toEqual({ kind: 'stop', busy: false, disabled: false });
  });

  it('已连接 + 有错误 → stop（连接优先于错误，杜绝橘「!」却执行停止的自相矛盾）', () => {
    expect(deriveConnectButtonState({ ...base, isConnected: true, hasError: true })).toEqual({
      kind: 'stop',
      busy: false,
      disabled: false,
    });
  });

  it('未连 + 已配置 → start 可点', () => {
    expect(deriveConnectButtonState(base)).toEqual({
      kind: 'start',
      busy: false,
      disabled: false,
    });
  });

  it('未连 + 未配置 → start 置灰', () => {
    expect(deriveConnectButtonState({ ...base, isServerConfigured: false }).disabled).toBe(true);
  });
});
