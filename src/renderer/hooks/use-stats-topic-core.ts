/**
 * useStatsTopic 的纯订阅控制器（React / DOM 无关，node 可单测）——batch3 §3.7 订阅驱动数据面。
 *
 * 管理某 topic 的「监听 + 订阅」生命周期：
 *  - attach：**先挂 EVENT_<topic> 监听再 invoke STATS_SUBSCRIBE**——main 侧 subscribe 内即 send 初始帧，监听须先
 *    就位否则初始帧丢失（合并原 GET 初值路径的关键顺序约束）。
 *  - detach：退监听 + invoke STATS_UNSUBSCRIBE。
 *  - 幂等：重复 attach（已订阅）/ detach（未订阅）安全 no-op。
 *
 * 此层不碰 ipcClient / react，故其单测无需 jsdom / window（渲染端 hook 逻辑的可测内核）。
 */
import { IPC_CHANNELS, STATS_TOPIC_EVENT, type StatsTopic } from '../../shared/ipc-channels';

/** controller 依赖的最小 IPC 面（生产接 ipcClient；测试传 mock）。 */
export interface StatsTopicIpc {
  /** invoke 订阅/退订（带 topic）；错误吞在 controller 内，不影响监听生命周期。 */
  invoke: (channel: string, args: { topic: StatsTopic }) => Promise<unknown>;
  /** 监听某通道，返回退订函数。 */
  on: (channel: string, listener: (data: unknown) => void) => () => void;
}

export interface StatsTopicSubscription {
  /** 挂监听 + 订阅（幂等：已 attach 则 no-op）。 */
  attach: () => void;
  /** 退监听 + 退订（幂等：未 attach 则 no-op）。 */
  detach: () => void;
  /** 当前是否已订阅（自检 / 测试用）。 */
  isAttached: () => boolean;
}

export function createStatsTopicSubscription<T>(
  topic: StatsTopic,
  onFrame: (data: T) => void,
  ipc: StatsTopicIpc
): StatsTopicSubscription {
  const channel = STATS_TOPIC_EVENT[topic];
  let unlisten: (() => void) | null = null;

  return {
    attach() {
      if (unlisten) return; // 已订阅，幂等
      // 先挂监听再订阅：main.subscribe 同步 send 初始帧，监听须先就位否则初始帧丢失。
      unlisten = ipc.on(channel, (d) => onFrame(d as T));
      void ipc.invoke(IPC_CHANNELS.STATS_SUBSCRIBE, { topic }).catch(() => {
        /* 订阅 invoke 失败（核未就绪等）：监听已挂、后续帧仍可达，静默 */
      });
    },
    detach() {
      if (!unlisten) return; // 未订阅，幂等
      unlisten();
      unlisten = null;
      void ipc.invoke(IPC_CHANNELS.STATS_UNSUBSCRIBE, { topic }).catch(() => {});
    },
    isAttached() {
      return unlisten !== null;
    },
  };
}
