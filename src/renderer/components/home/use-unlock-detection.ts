import { useCallback, useEffect, useRef, useState } from 'react';
import { UNLOCK_SERVICES, type UnlockResult, type UnlockStatus } from './unlock-service-config';
import { unlockApi } from '../../ipc/api-client';
import { useAppStore } from '../../store/app-store';
import { unlockOnProxyChange } from './unlock-staleness';

/**
 * 解锁检测状态钩子（PHASE-2 真实后端）。
 *
 * 对外接口不变（`{results,running,checkedAt,egress,run}`），内脏走真实 IPC。force 语义分流（H5）：
 *  - **自动路径**（挂载初检 / 失效重跑 / 代理连接态跃迁）一律 `force=false`——命中主进程 30min TTL + egressIp
 *    缓存则不重打，避免每次挂载/切换都强制全量重测（架空缓存）。
 *  - **手动刷新**（对外 `run()`，UnlockInline 刷新钮）= `force=true`——绕 TTL（仍受主进程 15s 硬下限约束）。
 *  - 挂载：先 `get()` 即时水合上次快照（零网络展示），无有效快照且代理在跑才自动初检 `runInternal(false)`；
 *    挂载 effect 同步认领 inflight，拦下 UnlockInline 挂载 `run()` 的强制检测（否则它会架空缓存）。
 *  - gating：`connectionStatus.proxyCore.running`——代理未运行不检测；起停/切节点由主进程广播 invalidated 复位重跑。
 */

export interface UnlockState {
  results: Record<string, UnlockResult>;
  running: boolean;
  checkedAt: number | null; // null = 未检测
  egress: { ip: string; region?: string } | null;
  /** 手动刷新冷却中（刚检测过 <15s）：刷新钮应置灰。 */
  cooldown: boolean;
  run: () => void;
}

const allChecking = (): Record<string, UnlockResult> =>
  Object.fromEntries(UNLOCK_SERVICES.map((s) => [s.id, { status: 'checking' as UnlockStatus }]));
const allTimeout = (): Record<string, UnlockResult> =>
  Object.fromEntries(UNLOCK_SERVICES.map((s) => [s.id, { status: 'timeout' as UnlockStatus }]));

// 就绪门重试已内化主进程（§10 D3 READINESS_BACKOFF_SCHEDULE_MS）——渲染端 M1 删除：M1 属 remount-lossy
// （切 tab/窗口重建丢待定重试），修掉 mount 重扫后该丢失不再被掩盖；重试归主进程 = 单飞 + epoch 守卫 + survives
// remount，结构性免疫。notReady 现由主进程提交终态快照，渲染端只复位 idle（S-gate 防重扫，恢复靠 invalidate/G-flip2）。

// 启动期 invalidate 风暴合并：一次冷启动/切节点会连发数条 invalidate（started + unlock-invalidate(M1) + TS 隧道
// 就绪）。每条都清空并即刻重跑 → 主进程 epoch churn 把较慢 checker（Claude 打 home+trace 两条，settle 晚于
// Spotify 单请求）的 progress 抑制掉 →「只亮一半 / Claude 持续灰」，须手动刷新才全亮。故 auto 路径防抖：最后一条
// invalidate 静默 N ms 后只跑一次干净全量检测（= 用户要的「完全启动完成再触发」）。手动刷新不防抖（即时）。
const AUTO_RUN_DEBOUNCE_MS = 1500;

// 手动刷新冷却（镜像主进程 UnlockDetectionService.FORCE_MIN_MS=15s：force 15s 内返缓存不重打）。窗内置灰刷新钮
// + tooltip 说明，避免「点了无变化」误解为坏。展示侧镜像值，与后端常量保持同步（后端为单一真值）。
const FORCE_COOLDOWN_MS = 15_000;

export function useUnlockDetection(): UnlockState {
  const proxyRunning = useAppStore((s) => !!s.connectionStatus?.proxyCore?.running);
  // R-gate（观感层）：选中 TS 出口直判无效时抑制自动检测的 spinner/IPC——主进程 M-gate 已是不变量（run() 短路），
  // 此处只防「allChecking spinner → 防抖 → IPC 往返」的 ~1.6s 假忙。手动刷新不受此拦（走 M-gate 毫秒级响应回路）。
  const exitBlocked = useAppStore(
    (s) => !!(s.connectionStatus?.proxyCore?.running && s.ipInfo?.proxyBlocked)
  );
  const [results, setResults] = useState<Record<string, UnlockResult>>({});
  const [running, setRunning] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [egress, setEgress] = useState<{ ip: string; region?: string } | null>(null);
  const [cooldown, setCooldown] = useState(false);
  const inflight = useRef(false); // 本地单飞：避免连点叠加 setState（主进程亦单飞）
  const autoRunTimer = useRef<number | null>(null); // auto 检测防抖定时器（合并启动 invalidate 风暴）
  const cooldownTimer = useRef<number | null>(null); // 手动刷新冷却定时器
  const proxyRunningRef = useRef(proxyRunning);
  proxyRunningRef.current = proxyRunning;
  const exitBlockedRef = useRef(exitBlocked);
  exitBlockedRef.current = exitBlocked;

  const clearAutoRun = useCallback(() => {
    if (autoRunTimer.current != null) {
      clearTimeout(autoRunTimer.current);
      autoRunTimer.current = null;
    }
  }, []);
  // 一轮真检测落地 → 开 15s 冷却（镜像后端 FORCE_MIN_MS），到点自动解除。
  const startCooldown = useCallback(() => {
    setCooldown(true);
    if (cooldownTimer.current != null) clearTimeout(cooldownTimer.current);
    cooldownTimer.current = window.setTimeout(() => {
      cooldownTimer.current = null;
      setCooldown(false);
    }, FORCE_COOLDOWN_MS);
  }, []);

  // 单一检测入口：force=false 走主进程 TTL/缓存/S-gate（自动路径）；force=true 手动刷新绕 TTL/S-gate（受 15s 硬下限）。
  // 就绪门重试已内化主进程（D3）→ 渲染端不再重试，各终态直接落定。
  const runInternal = useCallback(
    async (force: boolean) => {
      if (!proxyRunningRef.current) {
        setResults({}); // gating：无出口不检测，复位 idle
        setRunning(false);
        setCheckedAt(null);
        return;
      }
      if (inflight.current) return;
      inflight.current = true;
      setRunning(true);
      setResults(allChecking());
      try {
        const snap = await unlockApi.run(force);
        // 跑完发现代理已停（检测中途停代理）→ 丢弃本轮结果、不回填（避免停后回显陈旧）；finally 收口 spinner。
        if (!proxyRunningRef.current) return;
        if (snap.notReady) {
          // 就绪门未过（主进程已内化重试并提交终态）→ 落 idle + 开冷却（镜像后端 lastRunAt 15s，防手点无响应误解为坏）。
          setResults({});
          setCheckedAt(null);
          setEgress(null);
          startCooldown();
        } else if (snap.blockedReason) {
          // gating 短路（proxy-not-running / exit-invalid）→ idle，**不加**冷却（M-gate 毫秒级响应，允许反复点）。
          setResults({});
          setCheckedAt(null);
          setEgress(null);
        } else {
          setResults(snap.results);
          setCheckedAt(snap.checkedAt);
          setEgress(snap.egress);
          startCooldown(); // 真检测落地 → 开手动刷新 15s 冷却
        }
      } catch {
        setResults(allTimeout()); // IPC 失败兜底，不卡在 checking
      } finally {
        inflight.current = false;
        setRunning(false);
      }
    },
    [startCooldown]
  );

  // auto 检测防抖：合并启动/切节点的 invalidate 风暴为一次干净全量。窗口内显 spinner（非置灰），避免看着像没反应。
  // 自守 proxyRunning：未连不排。手动刷新与 reset 会 clearAutoRun 取消待定。
  const scheduleAutoRun = useCallback(() => {
    if (!proxyRunningRef.current) return;
    // R-gate：选中出口无效 → 不 spinner、不发 IPC、落 idle（M-gate 已保证后端零网络，此处只免 ~1.6s 假忙）。
    if (exitBlockedRef.current) {
      clearAutoRun();
      setResults({});
      setRunning(false);
      return;
    }
    clearAutoRun();
    setResults(allChecking());
    setRunning(true);
    autoRunTimer.current = window.setTimeout(() => {
      autoRunTimer.current = null;
      // 防抖到点二检：调度时有效但期间刚翻无效（invalidate 先于 proxyBlocked 广播抵达的 race）→ 此刻拦下。
      if (exitBlockedRef.current) {
        setResults({});
        setRunning(false);
        return;
      }
      void runInternal(false);
    }, AUTO_RUN_DEBOUNCE_MS);
  }, [clearAutoRun, runInternal]);

  // 对外 run = 手动刷新（force=true，绕 TTL）。UnlockInline 刷新钮点击走此。其挂载 run() 亦调此，但被下方
  // mount effect 同步认领的 inflight 拦下——挂载初检改由 mount effect 以防抖 auto 执行（吃缓存）。
  const run = useCallback(() => {
    clearAutoRun(); // 手动即时接管，取消待定的防抖 auto
    void runInternal(true);
  }, [runInternal, clearAutoRun]);

  // 挂载：同步认领 inflight（拦 UnlockInline 挂载 run(true) 抢先强制检测）→ get() 即时水合 → 无有效快照且
  // running 才自动初检 runInternal(false)。订阅 progress 逐个点亮 / invalidated 复位后视 running 重跑（force=false）。
  useEffect(() => {
    let mounted = true;
    inflight.current = true; // 同步认领：mount effect 先于 UnlockInline 的 run() effect 执行，抢占本地单飞
    setRunning(true);
    const release = (autoRun: boolean): void => {
      inflight.current = false;
      setRunning(false);
      if (autoRun) scheduleAutoRun(); // 自守 proxyRunning；防抖合并
    };
    void unlockApi
      .get()
      .then((snap) => {
        if (!mounted) return;
        if (snap && snap.checkedAt) {
          // 有有效快照 → 即时水合展示，不触发网络（缓存足够；run(false) 亦会命中同缓存，省一次往返）。
          setResults(snap.results);
          setCheckedAt(snap.checkedAt);
          setEgress(snap.egress);
          release(false);
        } else if (snap?.notReady) {
          // D4：notReady 失败终态快照 → 复位 idle、**不 autorun**（S-gate 兜住重扫；恢复靠 invalidate/G-flip2）。
          // 这是修掉「切 tab/窗口重建反复重扫死出口就绪门」风暴的渲染端一半（另一半 = 主进程 S-gate）。
          setResults({});
          setCheckedAt(null);
          setEgress(null);
          release(false);
        } else {
          // 无快照（S0：本 session 从未检测过，如 proxy 先于 home 挂载已 running）→ 释放认领并自动初检。
          release(true);
        }
      })
      .catch(() => {
        if (mounted) release(true); // get 失败 → 兜底自动初检
      });

    const offProgress = unlockApi.onProgress((p) => {
      setResults((prev) => ({ ...prev, [p.serviceId]: p.result }));
    });
    const offInvalidated = unlockApi.onInvalidated(() => {
      setCheckedAt(null);
      setEgress(null);
      // 防抖重跑：合并启动/切节点连发的多条 invalidate 为一次干净全量（不再每条即刻清空+重跑致 epoch churn 压
      // 掉较慢 checker 的 progress）。scheduleAutoRun 自守 proxyRunning；未连则复位 idle。
      if (proxyRunningRef.current) scheduleAutoRun();
      else setResults({});
    });
    return () => {
      mounted = false;
      clearAutoRun();
      if (cooldownTimer.current != null) clearTimeout(cooldownTimer.current);
      offProgress();
      offInvalidated();
    };
  }, [scheduleAutoRun, clearAutoRun]);

  // 代理连接态跃迁：false→true 自动检测（force=false）；true→false 复位 idle。挂载首次不触发（prev 同值），
  // 初检交 mount effect。
  const prevRunning = useRef(proxyRunning);
  useEffect(() => {
    const action = unlockOnProxyChange(prevRunning.current, proxyRunning);
    prevRunning.current = proxyRunning;
    if (action === 'detect') {
      scheduleAutoRun(); // 防抖合并（与 invalidate 风暴同治）
    } else if (action === 'reset') {
      // 停代理复位：必须显式收口本地态。scheduleAutoRun 置过 running=true 且其定时器被 clearAutoRun 取消
      // （runInternal 不再跑、其 finally 的 setRunning(false) 不执行）→ 不在此清则 spinner 永转（遮住冷却置灰态）。
      clearAutoRun();
      if (cooldownTimer.current != null) {
        clearTimeout(cooldownTimer.current);
        cooldownTimer.current = null;
      }
      inflight.current = false;
      setResults({});
      setCheckedAt(null);
      setEgress(null);
      setRunning(false);
      setCooldown(false);
    }
  }, [proxyRunning, scheduleAutoRun, clearAutoRun]);

  // 出口无效→有效 跃迁：R-gate 期间被拦的自动检测在出口恢复后补跑。**不依赖** UNLOCK_INVALIDATED 与 IP_INFO_UPDATED
  // （清 proxyBlocked）两事件的到达顺序——若 invalidate 先到，那次 scheduleAutoRun 仍被 R-gate 拦（proxyBlocked 未清），
  // 需本跃迁在 proxyBlocked 清后补一次重检，否则出口恢复却卡 idle。false→true 无需动作（G-flip invalidate + R-gate 已复位）。
  const prevExitBlocked = useRef(exitBlocked);
  useEffect(() => {
    const was = prevExitBlocked.current;
    prevExitBlocked.current = exitBlocked;
    if (was && !exitBlocked && proxyRunningRef.current) scheduleAutoRun();
  }, [exitBlocked, scheduleAutoRun]);

  return { results, running, checkedAt, egress, cooldown, run };
}
