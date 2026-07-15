import { useCallback, useEffect, useRef, useState } from 'react';
import type { UnlockResult } from './unlock-service-config';
import type { UnlockEgress } from '../../../shared/unlock-detection';
import { unlockApi } from '../../ipc/api-client';
import { useAppStore } from '../../store/app-store';

/**
 * 解锁检测状态钩子（issue 2 store 化）。
 *
 * 显示态（results/running/checkedAt/egress）+ 冷却基准（lastRunAt）全部来自 `store.unlock` —— 跨首页组件卸载存活：切导航
 * 离开首页 → UnlockInline 卸载但检测态留存，切回直接展示、**不从头重跑**（修「切页重新触发」）。progress/完成/失效由
 * use-native-events 持久订阅写 store（无论首页是否挂载均累积）；检测的**发起**唯一驱动 = 主进程 backend self-run（GAP-1）。
 *
 * 本 hook 只负责：
 *  - 读 store 显示态；
 *  - 手动刷新 run()（force 绕 TTL，仍受主进程 15s 硬下限）；
 *  - 冷却：由 store.unlock.lastRunAt **派生**（applyUnlockSnapshot 在真检测/notReady 完成时打戳）——统一 auto（self-run）
 *    + manual 两条完成路径都置灰刷新钮 15s，镜像后端 force-min；停代理清 lastRunAt → 冷却自动灭；
 *  - 冷水合：仅当 store 无检测态（窗口重建 / 代理已在跑但本会话尚未检测）时 get() 水合、必要时发起一次 run(false)。
 * gating：proxy 未运行 / 选中出口无效（R-gate）→ 不发起、显 idle（持久层 invalidate/停核复位 + 后端 blockedReason 收口）。
 */

export interface UnlockState {
  results: Record<string, UnlockResult>;
  running: boolean;
  checkedAt: number | null; // null = 未检测
  egress: UnlockEgress | null;
  /** 手动刷新冷却中（刚检测过 <15s）：刷新钮应置灰。 */
  cooldown: boolean;
  run: () => void;
}

// 手动刷新冷却（镜像主进程 UnlockDetectionService.FORCE_MIN_MS=15s：force 15s 内返缓存不重打）。窗内置灰刷新钮
// + tooltip 说明，避免「点了无变化」误解为坏。展示侧镜像值，与后端常量保持同步（后端为单一真值）。
const FORCE_COOLDOWN_MS = 15_000;

// store 是否已有可展示的检测态（结果/在检/已完成任一）。切页回来时据此跳过冷水合与自触发。
const hasUnlockState = (u: {
  results: Record<string, UnlockResult>;
  running: boolean;
  checkedAt: number | null;
}): boolean => u.checkedAt != null || u.running || Object.keys(u.results).length > 0;

export function useUnlockDetection(): UnlockState {
  const results = useAppStore((s) => s.unlock.results);
  const running = useAppStore((s) => s.unlock.running);
  const checkedAt = useAppStore((s) => s.unlock.checkedAt);
  const egress = useAppStore((s) => s.unlock.egress);
  const lastRunAt = useAppStore((s) => s.unlock.lastRunAt);
  const proxyRunning = useAppStore((s) => !!s.connectionStatus?.proxyCore?.running);
  // R-gate：选中 TS 出口直判无效 → 不发起（主进程 M-gate 已是不变量，此处防渲染端多余发起）。
  const exitBlocked = useAppStore(
    (s) => !!(s.connectionStatus?.proxyCore?.running && s.ipInfo?.proxyBlocked)
  );

  const [cooldown, setCooldown] = useState(false);
  const proxyRunningRef = useRef(proxyRunning);
  proxyRunningRef.current = proxyRunning;
  const exitBlockedRef = useRef(exitBlocked);
  exitBlockedRef.current = exitBlocked;

  // 冷却**派生自 store.unlock.lastRunAt**（真检测/notReady 完成打戳）：统一 auto（backend self-run）+ manual 完成路径，
  // 消除「auto 路径完成后 15s 内点刷新→假重检闪烁」。停代理 resetUnlock 清 lastRunAt → remaining≤0 → 灭。
  useEffect(() => {
    if (lastRunAt == null) {
      setCooldown(false);
      return;
    }
    const remaining = FORCE_COOLDOWN_MS - (Date.now() - lastRunAt);
    if (remaining <= 0) {
      setCooldown(false);
      return;
    }
    setCooldown(true);
    const timer = window.setTimeout(() => setCooldown(false), remaining);
    return () => clearTimeout(timer);
  }, [lastRunAt]);

  // 发起一次自动检测（force=false）并应用返回终态（保证 running 收口，含 cache-hit/S-gate 等不发 onComplete 的早退路径）。
  const kickAutoRun = useCallback(() => {
    if (!proxyRunningRef.current || exitBlockedRef.current) return;
    useAppStore.getState().beginUnlockCheck();
    void unlockApi
      .run(false)
      .then((snap) => useAppStore.getState().applyUnlockSnapshot(snap))
      .catch(() => {});
  }, []);

  // 手动刷新（force=true，绕 TTL）：置「检测中」→ 发起 → 应用返回终态（保证 running 收口，含 force-min/S-gate 早退）。
  // 只受 proxyRunning 闸（去 exitBlocked 闸）——主进程 M-gate 是不变量，出口恢复窗内 force 本可真跑；返回
  // blockedReason 也由 applyUnlockSnapshot 折叠 idle。冷却由 lastRunAt 派生，此处不手动开。
  const run = useCallback(() => {
    if (!proxyRunningRef.current) return;
    useAppStore.getState().beginUnlockCheck();
    void unlockApi
      .run(true)
      .then((snap) => useAppStore.getState().applyUnlockSnapshot(snap))
      .catch(() => {
        useAppStore.getState().resetUnlock(); // IPC 失败 → 复位 idle（不卡「检测中」）
      });
  }, []);

  // 冷水合（仅 store 无检测态时）：窗口重建 store 全空 / 代理已在跑但本会话尚未检测（backend self-run 尚未落）→
  // get() 水合上次快照；无有效快照且代理在跑/出口有效 → 发起一次 run(false)。store 已有态（切页回来）→ 整段 no-op：
  // 这正是「切导航不重跑」的核心。后续触发全由持久层（invalidate/停核）+ backend self-run 驱动，本 effect 只兜冷启动。
  useEffect(() => {
    if (hasUnlockState(useAppStore.getState().unlock)) return;
    let cancelled = false;
    // get() 水合本身零网络、**不受 gating**（窗口重建时 connectionStatus 尚未载入 → proxyRunningRef 陈旧
    // false，若整段被 proxyRunning 闸早退则 fresh lastSnapshot 永不恢复、解锁行空白）。是否**发起** run 交 kickAutoRun 自守。
    void unlockApi
      .get()
      .then((snap) => {
        if (cancelled || hasUnlockState(useAppStore.getState().unlock)) return; // 期间已被事件填充 → 不覆盖
        if (snap && (snap.checkedAt || snap.notReady || snap.blockedReason)) {
          useAppStore.getState().applyUnlockSnapshot(snap); // 有终态快照 → 水合展示（零网络）
        } else {
          kickAutoRun(); // 无快照（S0）→ 发起一次（内部自守 proxyRunning/exitBlocked）
        }
      })
      .catch(() => {
        if (!cancelled) kickAutoRun(); // get 失败 → 兜底发起（自守 gating）
      });
    return () => {
      cancelled = true;
    };
    // 挂载判一次即可；依赖恒稳，无需重跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { results, running, checkedAt, egress, cooldown, run };
}
