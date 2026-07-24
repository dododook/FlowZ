/**
 * RENDERER_READY 配置重放 —— 从 index.ts 的 RENDERER_READY handler 抽出（DI 化以可单测；index.ts 是无测试单体，
 * 循 startup-tasks.ts / config-change-handler.ts 从 index.ts 抽出的既有先例）。
 *
 * 不变量（#325）：renderer 每次挂载（含 reload）后必收到一次「当时终态 config」。silent-start 期主进程发出的
 * event:configChanged 在 renderer 挂载前无窗口订阅者、被静默丢弃（见 ipc-events.sendToAll 遍历空 windows 集合），
 * 而 mount-time 单发 loadConfig 快照若恰落在启动 churn 中（订阅补更改写 servers / F14 reselect 改 selectedServerId）
 * 即定格「无节点」。此处在收到 RENDERER_READY 时向该 webContents **无条件**重放一次终态 config 补偿——把不变量从
 * 「碰运气」变协议保证。一次 replay 同覆盖三类丢失：①silent-start 无窗期（本 issue）②建窗后 renderer boot 到
 * listener 注册前的空窗 ③mount-gate reload 后的空窗（reload 重发 RENDERER_READY → 再 replay，白捡自愈）。
 *
 * 幂等：多发一次同值事件 → renderer applyConfigFromEvent 同值 setState 无害；不依赖 silent-start 门控 / mount-gate
 * 状态（避免与 gate 状态机耦合）。绝不打断 mount gate：读 config 失败只 warn 不抛。
 */

/** DI 依赖：与 index.ts / Electron / configManager 解耦，纯逻辑可单测。 */
export interface RendererReadyReplayDeps<C> {
  /** 读当时终态 config（configManager.loadConfig，读内存缓存近零成本）。 */
  loadConfig: () => Promise<C>;
  /** 向目标 webContents 发 EVENT_CONFIG_CHANGED（payload { newValue }）。 */
  send: (config: C) => void;
  /** 中止判定（isQuitting || webContents.isDestroyed()）；await 前后各查一次，避免向已销毁 wc send 抛错。 */
  isAborted: () => boolean;
  /** 读失败告警（logManager.addLog('warn', …)）；绝不影响 mount gate。 */
  warn: (message: string) => void;
}

/**
 * fire-and-forget：在 RENDERER_READY 时重放终态 config。异常内部吞（只 warn，绝不抛/阻塞 mount gate），
 * 调用方 `void` 即可。
 */
export async function replayConfigOnRendererReady<C>(
  deps: RendererReadyReplayDeps<C>
): Promise<void> {
  const { loadConfig, send, isAborted, warn } = deps;
  if (isAborted()) return;
  try {
    const config = await loadConfig();
    // await 期间可能进入退出 / webContents 销毁 → 再查一次，防向已销毁 wc send 抛错。
    if (isAborted()) return;
    send(config);
  } catch (err) {
    warn(
      `RENDERER_READY config replay failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
