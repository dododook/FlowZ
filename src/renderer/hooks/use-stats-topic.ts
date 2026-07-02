/**
 * useStatsTopic —— 渲染端按 topic 订阅 stats 数据面（batch3 §3.7，取代拓扑/连接页/流量三处各自订阅 + GET/event 双路径）。
 *
 * 挂载且可见 → 订阅（invoke STATS_SUBSCRIBE + 监听 EVENT_<topic>，订阅即拿初始帧）；unmount / 文档隐藏
 * （document.visibilityState==='hidden'，Electron 窗口 hide/最小化即触发）→ 退订；可见恢复 → 重订（重订自然拿
 * 初始帧 = 原 resume 补帧免费获得）。main 侧据订阅集派生 worker demand：无订阅者逐级停机（含非首页可见视图下拓扑流亦停）。
 *
 * onFrame 经 ref 稳定：帧到达时读最新 onFrame，useEffect 依赖仅 [topic, enabled]，不随每次渲染新建的 onFrame
 * 抖动重订（参照 use-native-events 模块级 handler 稳定引用的教训）。
 *
 * @param enabled 消费方门控（默认 true）：连接页「暂停」时传 false → 退订停流（worker detail 逐级停机），恢复 true
 *   → 重订拿最新初始帧。与可见性门控独立：两者任一不满足即退订。
 */
import { useEffect, useRef } from 'react';
import { ipcClient } from '../ipc/ipc-client';
import type { StatsTopic } from '../../shared/ipc-channels';
import { createStatsTopicSubscription } from './use-stats-topic-core';

export function useStatsTopic<T>(
  topic: StatsTopic,
  onFrame: (data: T) => void,
  enabled = true
): void {
  // onFrame 经 ref 稳定：帧到达读最新 onFrame，effect 不因 onFrame 每渲染新建而重订（防抖动）。
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  useEffect(() => {
    const sub = createStatsTopicSubscription<T>(topic, (d) => onFrameRef.current(d), {
      invoke: (channel, args) => ipcClient.invoke(channel, args),
      on: (channel, listener) => ipcClient.on(channel, listener),
    });
    // 可见 + enabled 才订阅；隐藏 / 禁用则退订。visibilitychange 上同步。
    const sync = () => {
      if (enabled && document.visibilityState !== 'hidden') sub.attach();
      else sub.detach();
    };
    sync(); // 挂载即按当前可见性 / enabled 决定
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      sub.detach();
    };
  }, [topic, enabled]);
}
