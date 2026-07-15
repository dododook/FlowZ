/**
 * 主进程「渲染端 mount 健康门」的纯状态机（GAP-1a，供单测）。
 *
 * 治的是 C 类白屏：**renderer 进程活着但 DOM 空**——模块级 import 抛错 / App 函数体或 provider 在 render 前
 * 抛错时，Chromium 既不发 render-process-gone（进程没死）也不发 did-fail-load（HTML 加载成功了），A/B 两类
 * 自愈全漏。唯一能从主进程侧侦测的手段：约定 renderer mount 成功后回发 RENDERER_READY，主进程 did-finish-load
 * 后武装超时；到点没收到 = mount 失败。
 *
 * 本模块只做纯决策（无 electron 依赖，全可单测）；计时器/reload/对话框/日志等副作用留在 index.ts 接线层。
 */

/** 门接收的事件：HTML 加载完成 / 收到就绪信号 / 计时到点。 */
export type MountGateEvent = 'loadFinished' | 'rendererReady' | 'timeout';

/**
 * 门决策出的动作，交接线层执行：
 * - `arm`  武装（先清旧计时器再起新计时器）
 * - `clear` 清计时器（mount 已确认，门满足）
 * - `reload` 清计时器 + 重载一次（覆盖瞬态 mount 失败）
 * - `fatal` 清计时器 + 终局兜底（静态错误页 + 对话框 + 强制呈现），门自此停用
 * - `none` 无操作
 */
export type MountGateAction = 'arm' | 'clear' | 'reload' | 'fatal' | 'none';

export interface MountGateState {
  /** RENDERER_READY 已收到（App 成功 render+commit）。 */
  ready: boolean;
  /** 已因 mount 超时 reload 过一次（首次 vs 终局的区分位）。 */
  reloaded: boolean;
  /** 已进入终局兜底（加载静态错误页）→ 门彻底停用。 */
  finalized: boolean;
  /**
   * 一次 timeout 触发的 reload **在途**：从发起 reload 起，到重载页的 loadFinished 到达为止。此窗口内到达的
   * rendererReady 一律**丢弃**——它来自 pre-reload 旧页的在途 IPC，若被采信会把 ready 置 true，使重载页的
   * loadFinished 走「已 ready → 不武装」→ 门对该次 reload 永久失明（若重载页又 C 类失败则无兜底）。
   */
  reloading: boolean;
}

export function initialMountGateState(): MountGateState {
  return { ready: false, reloaded: false, finalized: false, reloading: false };
}

/**
 * 纯状态转移。要点：
 * 1. did-finish-load 是**唯一武装点**——reload 后它必再触发，天然重新武装，无需接线层显式补武装（避免叠加计时器）。
 * 2. ready 早于 did-finish-load 的竞态（React effect 与 load 事件顺序不保证）：loadFinished 时若已 ready 则不武装，
 *    否则会武装一个永不清除的计时器 → 误触发 reload。
 * 3. finalized 后一切事件 no-op：终局静态错误页自身的 did-finish-load 不得再武装，否则 loadURL→timeout→loadURL 死循环。
 * 4. reloading（L1 不变量）：timeout→reload 后置位，丢弃 pre-reload 陈旧 ready；重载页 loadFinished 到达时清位并
 *    **无条件重新武装**（不看陈旧 ready），保证「reload 后不失明」。
 */
export function reduceMountGate(
  state: MountGateState,
  event: MountGateEvent
): { state: MountGateState; action: MountGateAction } {
  if (state.finalized) return { state, action: 'none' };

  switch (event) {
    case 'rendererReady':
      // reload 在途：丢弃 pre-reload 旧页的迟到 ready（否则重载页会被判「已 ready」而失明）。
      if (state.reloading) return { state, action: 'none' };
      // mount 确认：清计时并置 ready（幂等——重复 ready 只是重复 clear）。
      return { state: { ...state, ready: true }, action: 'clear' };

    case 'loadFinished':
      // 重载页到达：清 reloading 并无条件重新武装（陈旧 ready 已在上面被丢弃，这里 ready 恒为 false）。
      if (state.reloading) return { state: { ...state, reloading: false }, action: 'arm' };
      if (state.ready) return { state, action: 'none' }; // 已就绪 → 不武装（竞态保护）
      return { state, action: 'arm' };

    case 'timeout':
      if (state.ready) return { state, action: 'none' }; // 安全网：就绪后不应再有计时器
      if (!state.reloaded)
        return { state: { ...state, reloaded: true, reloading: true }, action: 'reload' };
      return { state: { ...state, finalized: true }, action: 'fatal' };
  }
}
