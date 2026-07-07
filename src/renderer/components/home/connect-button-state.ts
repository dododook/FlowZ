/**
 * 首页连接圆钮三态推导 —— 纯函数，从 ConnectionControlCard 抽出，无 react/store 依赖，供 .test.ts 覆盖状态矩阵。
 *
 * 三态（+ 进行中相位）：
 *  - start：未连接 → teal ▶（点击 startProxy）；未配置节点则 disabled。
 *  - stop：已连接 → 红 ‖（点击 stopProxy）；恒可点（断开不受配置完整性约束）。
 *  - error：有错误且未连接 → 橘 !（点击重试 = startProxy）；未配置节点则 disabled。
 *  - starting/stopping：proxyPhase 非 idle → spinner，busy 期间 disabled。
 */
export type ConnectButtonKind = 'start' | 'stop' | 'error' | 'starting' | 'stopping';

export interface ConnectButtonState {
  kind: ConnectButtonKind;
  /** 进行中（spinner）。 */
  busy: boolean;
  /** 是否禁用点击。 */
  disabled: boolean;
}

export interface ConnectButtonInputs {
  proxyPhase: 'idle' | 'starting' | 'stopping';
  isConnected: boolean;
  hasError: boolean;
  isServerConfigured: boolean;
}

export function deriveConnectButtonState(input: ConnectButtonInputs): ConnectButtonState {
  const { proxyPhase, isConnected, hasError, isServerConfigured } = input;
  if (proxyPhase === 'starting') return { kind: 'starting', busy: true, disabled: true };
  if (proxyPhase === 'stopping') return { kind: 'stopping', busy: true, disabled: true };
  // 已连接优先于 error：核已运行时按钮须显「停止」（点击 stopProxy），否则残留 proxyError + 核运行
  // 会让按钮显橘「!」却在点击时执行停止，自相矛盾。仅「未连接 + 有错误」才是可重试的 error 态。
  if (isConnected) return { kind: 'stop', busy: false, disabled: false };
  if (hasError) return { kind: 'error', busy: false, disabled: !isServerConfigured };
  return { kind: 'start', busy: false, disabled: !isServerConfigured };
}
