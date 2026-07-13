/**
 * §2 待应用差集动作条 —— 节点页列表顶部。当节点集相对运行核启动快照存在增/改差集时显示汇总 +「立即应用」一键（F-2：removed 已移除）。
 *
 * 数据源 = store.pendingChanges（pull 模型，configChanged/proxyStarted/proxyStopped 后由 refreshPendingChanges 刷新）。
 * 语义：restartOnNodeChange OFF（默认）下节点变更 defer 进此差集，用户点「立即应用」force-restart 入核；ON 下变更自动
 * 重启、差集瞬态即清（本条自然隐藏）。核未运行 → 差集全空 → 不渲染。
 *
 * 「立即应用」= applyPendingChanges（复用 F11 applyConfigForcingRestart，去抖 ~1.5s 后整核重启）。重启完成经
 * EVENT_PROXY_STARTED → refreshPendingChanges 自动清差集、本条卸载；applying 本地态仅防重复点击（带超时兜底复位）。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/ipc';
import { useAppStore } from '@/store/app-store';

export function PendingChangesBar() {
  const { t } = useTranslation();
  const pending = useAppStore((s) => s.pendingChanges);
  const [applying, setApplying] = useState(false);
  // 兜底复位定时器引用：供卸载/重触发时 clear，防卸载后 setApplying 空跑（Nit-1）。
  const applyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const total = pending.added.length + pending.modified.length;

  // 差集清空（重启已入核）→ 复位 applying（本条即将卸载，稳妥起见仍复位，防父组件缓存实例）。
  useEffect(() => {
    if (total === 0 && applying) setApplying(false);
  }, [total, applying]);

  // 卸载时清兜底定时器（成功路径 <5s 卸载时定时器仍在飞 → clear 防泄漏/卸载后空跑）。
  useEffect(
    () => () => {
      if (applyTimerRef.current) clearTimeout(applyTimerRef.current);
    },
    []
  );

  if (total === 0) return null;

  const handleApply = () => {
    if (applying) return;
    setApplying(true);
    void api.proxy
      .applyPendingChanges()
      .then((res) => {
        // 据实际应用状态分流反馈，避免「无论是否真重启一律成功」的死信息（review #291 finding 4）。
        if (res.status === 'applied') toast.success(t('servers.pendingApplying'));
        else if (res.status === 'deferred')
          toast.info(t('servers.pendingApplyDeferred')); // 换核/操作中 → 稍后自动生效
        else toast.info(t('servers.pendingApplySkipped')); // 代理未运行 → 下次启动生效
      })
      .catch(() => {
        toast.error(t('servers.pendingApplyFailed'));
        setApplying(false);
      });
    // 兜底复位：applyConfigForcingRestart 内部 guard 可能因代理未运行/换核窗口不实际重启（无 STARTED 事件回清）→
    // 5s 后复位 applying，避免按钮永久禁用。差集若已清由上方 effect 复位、此处 no-op。前一个未触发的先 clear。
    if (applyTimerRef.current) clearTimeout(applyTimerRef.current);
    applyTimerRef.current = setTimeout(() => setApplying(false), 5000);
  };

  // 明细拆分（新增/修改，仅非零项）。用中点 ` · ` 连接（locale-neutral），不再用全角括号「（…）」硬编码
  // （en/ru/fa 下 CJK 标点突兀）；也不再重复到原生 title（可见 span 已呈现，Electron title 本就不稳）。
  const parts: string[] = [];
  if (pending.added.length) parts.push(t('servers.pendingAdded', { count: pending.added.length }));
  if (pending.modified.length)
    parts.push(t('servers.pendingModified', { count: pending.modified.length }));

  return (
    <div className="nd-batch">
      <Clock className="h-4 w-4 shrink-0" style={{ color: 'hsl(var(--warn))' }} />
      <span className="nd-batch-n">
        {t('servers.pendingChangesSummary', { count: total })}
        {parts.length > 0 && <span className="ms-2 text-fg-faint">{parts.join(' · ')}</span>}
      </span>
      <div className="nd-batch-acts">
        <button type="button" className="btn flow sm" disabled={applying} onClick={handleApply}>
          <RefreshCw className={applying ? 'animate-spin' : ''} />
          {applying ? t('servers.pendingApplying') : t('servers.pendingApplyNow')}
        </button>
      </div>
    </div>
  );
}
