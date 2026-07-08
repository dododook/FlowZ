import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Activity, Search, Pause, Play, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc';
import { useStatsTopic } from '@/hooks/use-stats-topic';
import { toast } from 'sonner';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ConnectionEntry, ConnectionsSnapshot } from '../../../shared/types';
import {
  computeConnSpeeds,
  destOf,
  sourceOf,
  typeOf,
  chainOf,
  durationSec,
  fmtDuration,
  parseRule,
  isBlockedAction,
  type ConnSpeed,
  type RateState,
} from './connection-utils';

type SortKey = 'type' | 'source' | 'dest' | 'rule' | 'chain' | 'speed' | 'traffic' | 'time';
type SortDir = 'asc' | 'desc';

/** 规则去向 action → Conduit pill 配色：direct 中性灰 / block 系危险红 / 其它(proxy·具体节点) 主色。 */
function ruleActionPillClass(action: string): 'direct' | 'proxy' | 'block' {
  if (action.toLowerCase() === 'direct') return 'direct';
  if (isBlockedAction(action)) return 'block';
  return 'proxy';
}

/** 稳定的零速率引用：speeds 无此 id 时传入，使 ConnectionRow memo 的 speed 比较恒定（不每帧新建对象）。 */
const ZERO_SPEED: ConnSpeed = { up: 0, down: 0 };

/**
 * 全表共享秒级 tick（P3）：时长列每秒刷新原本随父组件 setNow 触发整表 reconcile（重跑 visible.map + diff ≤500 行）。
 * 改为模块级外部 store + useSyncExternalStore：1s tick 只重渲订阅它的各 DurationCell（纯文本），不穿透
 * ConnectionRow 的 memo → 整行/整表不因时长刷新而 reconcile。仅有订阅者时跑 interval（无连接页=零开销）；
 * 暂停由表 setDurationTicking(false) 冻结（与快照冻结一致）。单连接页实例，模块级状态安全。
 */
let durationNow = Date.now();
let durationTimer: ReturnType<typeof setInterval> | null = null;
let durationTicking = true;
const durationListeners = new Set<() => void>();
function subscribeDuration(cb: () => void): () => void {
  durationListeners.add(cb);
  if (!durationTimer) {
    durationTimer = setInterval(() => {
      if (!durationTicking) return;
      durationNow = Date.now();
      durationListeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    durationListeners.delete(cb);
    if (durationListeners.size === 0 && durationTimer) {
      clearInterval(durationTimer);
      durationTimer = null;
    }
  };
}
function getDurationNow(): number {
  return durationNow;
}
function setDurationTicking(v: boolean): void {
  durationTicking = v;
}

/** 时长单元（P3）：订阅共享秒 tick 独立自刷新，使整行不因时长每秒变化而 reconcile（绕过 ConnectionRow memo）。 */
const DurationCell = memo(function DurationCell({ start }: { start?: string }) {
  const now = useSyncExternalStore(subscribeDuration, getDurationNow, getDurationNow);
  return <>{fmtDuration(durationSec({ start } as ConnectionEntry, now))}</>;
});

interface ConnectionRowProps {
  conn: ConnectionEntry;
  speed: ConnSpeed;
  onClose: (id: string) => void;
  closeLabel: string;
}

/**
 * 单连接行（P3）：memo 按「会变的展示字段」比较——对固定连接 id，仅上下行累计(traffic)与速率会变，
 * 其余(规则/目标/源/链/进程)在 clash 连接创建时即定型恒不变。故 id+upload+download+speed 相等 ⇒ 整行视图不变、
 * 跳过 reconcile（2s 快照下 idle 连接行不再无谓重渲）。时长由内嵌 DurationCell 经共享 tick 自刷新，不入本比较。
 */
const ConnectionRow = memo(
  function ConnectionRow({ conn: c, speed: s, onClose, closeLabel }: ConnectionRowProps) {
    const m = c.metadata || {};
    const proc = m.processPath || '-';
    const procName = proc === '-' ? '-' : proc.split(/[/\\]/).pop() || proc;
    const rv = parseRule(c.rule, c.rulePayload);
    // 状态即形（Conduit）：被阻断的连接整行弱化（无流量、语义上「已丢弃」→ 视觉退后）；
    // 零速率的速率读数转中性灰（idle 连接不与活跃传输争夺注意力，突出真正在跑的行）。
    const blocked = isBlockedAction(rv.action);
    const zeroRate = s.up === 0 && s.down === 0;
    // 类型 pill：形+色区分（tcp 实底灰 / udp 描边），文本取 L4 proto，完整 network/type 收进 title。
    const network = (m.network || '').toLowerCase();
    const typeText = typeOf(c);
    const protoLabel = m.network || typeText;
    // 节点链：直连/阻断/无出站 → node-dim 弱化（不与代理链争注意力）。
    const chain = chainOf(c);
    const nodeDim = blocked || (rv.action || '').toLowerCase() === 'direct' || chain === '-';
    const dl = c.download ?? 0;
    const ul = c.upload ?? 0;
    const trafficTotal = dl + ul;
    return (
      <tr className={blocked ? 'blocked' : undefined}>
        <td className="cx">
          <button className="crow-x" title={closeLabel} onClick={() => onClose(c.id)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </td>
        <td>
          <span className={cn('pill', network === 'udp' ? 'udp' : 'tcp')} title={typeText}>
            {protoLabel}
          </span>
        </td>
        <td>
          {m.sourceIP ? (
            <span className="mono tnum">
              {m.sourceIP}
              {m.sourcePort ? <span className="pt">:{m.sourcePort}</span> : null}
            </span>
          ) : (
            <span className="mono tnum">-</span>
          )}
        </td>
        <td>
          <span className="ell" title={destOf(c)}>
            {destOf(c)}
          </span>
        </td>
        <td>
          {rv.action ? (
            <div className="rule-cell">
              <span className={cn('pill', ruleActionPillClass(rv.action))}>{rv.action}</span>
              {rv.type ? (
                <span className="rc-cond mono ell md" title={rv.full || undefined}>
                  {rv.type}
                </span>
              ) : null}
            </div>
          ) : (
            <span className="ell md" title={rv.full || undefined}>
              {rv.full || '-'}
            </span>
          )}
        </td>
        <td>
          <span className={cn('ell md', nodeDim && 'node-dim')} title={chain}>
            {chain}
          </span>
        </td>
        <td className="num">
          <div className="rt">
            <span className={cn('dn mono tnum', zeroRate && 'zero')}>
              ↓ {formatBytes(s.down)}/s
            </span>
            <span className={cn('up mono tnum', zeroRate && 'zero')}>↑ {formatBytes(s.up)}/s</span>
          </div>
        </td>
        <td className="num">
          <span
            className={cn('mono tnum', trafficTotal === 0 && 'zero')}
            title={`↓ ${formatBytes(dl)} / ↑ ${formatBytes(ul)}`}
          >
            {formatBytes(trafficTotal)}
          </span>
        </td>
        <td className="num">
          <span className="mono tnum">
            <DurationCell start={c.start} />
          </span>
        </td>
        <td>
          <span className="ell sm" title={proc}>
            {procName}
          </span>
        </td>
      </tr>
    );
  },
  // memo 比较：只比会变的展示字段。**契约**：对固定 conn.id，chains/rule/rulePayload/metadata（→ chainOf/parseRule/
  // destOf/sourceOf/typeOf/processPath）在 clash 连接生命周期内不可变（切节点创建新连接、不改已有 id），故不入比较。
  // ⚠️ 若上游（trimConnection / sing-box）改为对已有 id 回填/修正这些字段，须把对应字段纳入比较，否则行静默不更新。
  (prev, next) =>
    prev.onClose === next.onClose &&
    prev.closeLabel === next.closeLabel &&
    prev.conn.id === next.conn.id &&
    (prev.conn.upload ?? 0) === (next.conn.upload ?? 0) &&
    (prev.conn.download ?? 0) === (next.conn.download ?? 0) &&
    prev.speed.up === next.speed.up &&
    prev.speed.down === next.speed.down
);

export function ConnectionsTable() {
  const { t } = useTranslation();
  const proxyRunning = useAppStore((s) => s.connectionStatus?.proxyCore?.running ?? false);

  const [connections, setConnections] = useState<ConnectionEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('time');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [speeds, setSpeeds] = useState<Map<string, ConnSpeed>>(new Map());
  const [confirmCloseAll, setConfirmCloseAll] = useState(false);

  // per-conn 速率差分的上一帧缓存（不入 state，避免无谓重渲染）。
  const rateRef = useRef<RateState>(new Map());

  // 数据（batch3 §3.7）：连接明细改【订阅驱动 push】——订阅 'detail' topic，挂载即拿初始帧，之后 worker 每帧
  // push（取代旧每 PULL_INTERVAL_MS 拉 CONNECTIONS_GET + in-flight 守卫）。暂停（enabled=!paused → 退订）停流
  // （worker detail 逐级停机）+ 冻结当前帧；恢复重订拿最新初始帧。窗口隐藏由 useStatsTopic 自动退订。
  const applyDetail = useCallback((snap: ConnectionsSnapshot) => {
    // 速率差分照旧：push 帧带 worker 采样 at，computeConnSpeeds 以前后帧 + 采样间隔算速率（push 改造不影响差分）。
    const { speeds: s, next } = computeConnSpeeds(snap.connections, rateRef.current, snap.at);
    rateRef.current = next;
    setSpeeds(s);
    setConnections(snap.connections);
  }, []);
  useStatsTopic<ConnectionsSnapshot>('detail', applyDetail, !paused);

  // 时长列刷新与整表 reconcile 解耦（P3）：秒级 tick 下沉到模块级共享 store，仅 DurationCell 订阅、
  // 自刷新文本，不再随 setNow 重跑 visible.map + reconcile ≤500 行。暂停时冻结 tick（与快照冻结一致）。
  useEffect(() => {
    setDurationTicking(!paused);
  }, [paused]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = connections;
    if (q) {
      list = connections.filter((c) => {
        const m = c.metadata || {};
        const hay = [
          m.host,
          m.destinationIP,
          m.sourceIP,
          c.rule,
          c.rulePayload,
          chainOf(c),
          m.processPath,
          m.network,
          m.type,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      });
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    const speedOf = (c: ConnectionEntry) => {
      const s = speeds.get(c.id);
      return s ? s.up + s.down : 0;
    };
    const trafficOf = (c: ConnectionEntry) => (c.upload ?? 0) + (c.download ?? 0);
    // 排序用连接起始时间戳（无/非法 start 垫底）替代 durationSec(c, now)：作差时 now 对所有行相同、完全抵消
    // （durationSec(a,now)-durationSec(b,now) === startMs(b)-startMs(a)），故 time 排序无需 now → filtered 不
    // 再依赖 now，避免每秒时长刷新触发整表重排（LOW-A）。now 仍用于时长列显示（见 fmtDuration(durationSec)）。
    const startMs = (c: ConnectionEntry) => {
      if (!c.start) return Infinity;
      const t = Date.parse(c.start);
      return isNaN(t) ? Infinity : t;
    };
    const cmp = (a: ConnectionEntry, b: ConnectionEntry): number => {
      switch (sortKey) {
        case 'type':
          return typeOf(a).localeCompare(typeOf(b)) * dir;
        case 'source':
          return sourceOf(a).localeCompare(sourceOf(b)) * dir;
        case 'dest':
          return destOf(a).localeCompare(destOf(b)) * dir;
        case 'rule':
          return a.rule.localeCompare(b.rule) * dir;
        case 'chain':
          return chainOf(a).localeCompare(chainOf(b)) * dir;
        case 'speed':
          return (speedOf(a) - speedOf(b)) * dir;
        case 'traffic':
          return (trafficOf(a) - trafficOf(b)) * dir;
        case 'time':
          return (startMs(b) - startMs(a)) * dir;
        default:
          return 0;
      }
    };
    return [...list].sort(cmp);
  }, [connections, search, sortKey, sortDir, speeds]);

  // 大列表渲染保护（LOW-B）：连接数极多时全量 .map 撑爆 DOM + 拖慢每秒重渲染。代理活动连接通常几十到几百，
  // 超过软上限只渲染前 N 行并提示用搜索缩小（<table> 语义下真虚拟化需破坏表结构、收益有限，取此务实方案）。
  const MAX_VISIBLE_ROWS = 500;
  const visible =
    filtered.length > MAX_VISIBLE_ROWS ? filtered.slice(0, MAX_VISIBLE_ROWS) : filtered;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  // useCallback 稳定引用：作为 ConnectionRow 的 onClose prop，避免每次父渲染新建函数使 memo 失效。
  const handleClose = useCallback(
    async (id: string) => {
      try {
        const { ok } = await api.connections.close(id);
        if (ok) {
          // 乐观移除：下一帧快照若仍在会再回填（极少见），但即时反馈更顺手
          setConnections((prev) => prev.filter((c) => c.id !== id));
        } else {
          toast.error(t('connections.closeFailed'));
        }
      } catch {
        toast.error(t('connections.closeFailed'));
      }
    },
    [t]
  );

  const handleCloseAll = async () => {
    setConfirmCloseAll(false);
    try {
      const { ok } = await api.connections.closeAll();
      if (ok) {
        setConnections([]);
        rateRef.current = new Map();
        setSpeeds(new Map());
        toast.success(t('connections.closeAllDone'));
      } else {
        toast.error(t('connections.closeAllFailed'));
      }
    } catch {
      toast.error(t('connections.closeAllFailed'));
    }
  };

  // 可排序表头：active 列 teal（.on）+ 显向 caret（▲/▼），非 active 列 caret hover 淡显（.car 默认 ▲）。
  const sortableHeader = (k: SortKey, label: string, num?: boolean) => {
    const active = sortKey === k;
    return (
      <th className={cn('srt', num && 'num', active && 'on')} onClick={() => toggleSort(k)}>
        {label}
        <span className="car">{active ? (sortDir === 'asc' ? '▲' : '▼') : '▲'}</span>
      </th>
    );
  };

  return (
    <>
      {/* 顶栏：摘要先行（连接总数 KPI + 实时/暂停指示）+ 搜索 + 暂停/恢复 + 全部关闭 */}
      <div className="conns-bar">
        <div className="conns-sum">
          <span className="n mono tnum">{connections.length}</span>
          <span className="l">{t('connections.active')}</span>
        </div>
        {/* 数据流态：暂停 → 中性静态点「已暂停」；运行且未暂停 → teal 呼吸点「实时」；未运行不显（空态已说明）。 */}
        {paused ? (
          <span className="pill idle">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: 'hsl(var(--fg-faint))' }}
            />
            {t('connections.paused')}
          </span>
        ) : proxyRunning ? (
          <span className="pill ok clive">
            <span className="ldot motion-safe:animate-pulse" />
            {t('connections.live')}
          </span>
        ) : null}
        <div className="conns-search">
          <Search />
          <input
            type="text"
            placeholder={t('connections.search')}
            aria-label={t('connections.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button
          className="btn ghost sm conns-pause"
          title={paused ? t('connections.resume') : t('connections.pause')}
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
          {paused ? t('connections.resume') : t('connections.pause')}
        </button>
        <button
          className="btn danger sm"
          title={t('connections.closeAll')}
          onClick={() => setConfirmCloseAll(true)}
          disabled={connections.length === 0}
        >
          <X size={13} />
          {t('connections.closeAll')}
        </button>
      </div>

      {/* 数据表卡：宽表自身横向滚动 · sticky 表头 hairline 分隔 · 截断脚注常驻卡底 · 空态居中于卡内 */}
      <div className="card conns-card">
        {filtered.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-16 text-center">
            <Activity className="h-6 w-6" style={{ color: 'hsl(var(--fg-faint))' }} />
            <span className="text-[13px]" style={{ color: 'hsl(var(--fg-faint))' }}>
              {connections.length > 0 && search
                ? t('connections.noMatch')
                : proxyRunning
                  ? t('connections.noActive')
                  : t('connections.plsStartProxy')}
            </span>
          </div>
        ) : (
          <>
            <div className="conns-scroll">
              {/* fit-to-width：数字列（速率/流量/时长）+ 操作/类型列固定像素恒显；文本列（源/目标/规则/链路/进程）
                  弹性收缩 + .ell 截断（长节点名/IP 不挤占数字列，用户反馈）。table-layout:fixed + 内联 minWidth 覆盖
                  conduit .ctbl 的 min-width:1000（否则窄窗强制横滚、右侧速率/连接数被隐）。 */}
              <table
                className="ctbl ctbl-fit"
                style={{ tableLayout: 'fixed', width: '100%', minWidth: 720 }}
              >
                <colgroup>
                  <col style={{ width: 34 }} />
                  <col style={{ width: 54 }} />
                  <col />
                  <col />
                  <col />
                  <col />
                  <col style={{ width: 104 }} />
                  <col style={{ width: 82 }} />
                  <col style={{ width: 64 }} />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th className="cx" aria-label={t('connections.close')} />
                    {sortableHeader('type', t('connections.colType'))}
                    {sortableHeader('source', t('connections.colSource'))}
                    {sortableHeader('dest', t('connections.colDest'))}
                    {sortableHeader('rule', t('connections.colRule'))}
                    {sortableHeader('chain', t('connections.colChain'))}
                    {sortableHeader('speed', t('connections.colSpeed'), true)}
                    {sortableHeader('traffic', t('connections.colTraffic'), true)}
                    {sortableHeader('time', t('connections.colTime'), true)}
                    <th>{t('connections.colProcess')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => (
                    <ConnectionRow
                      key={c.id}
                      conn={c}
                      speed={speeds.get(c.id) ?? ZERO_SPEED}
                      onClose={handleClose}
                      closeLabel={t('connections.close')}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            {/* 500 行截断保护提示行（常驻卡底 · warn 语义） */}
            {filtered.length > MAX_VISIBLE_ROWS && (
              <div className="conns-foot">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.9}
                  width={14}
                  height={14}
                >
                  <path
                    d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>
                  {t('connections.rowsTruncated', {
                    shown: MAX_VISIBLE_ROWS,
                    total: filtered.length,
                  })}
                </span>
              </div>
            )}
          </>
        )}
      </div>

      {/* 全部关闭确认弹窗 */}
      <AlertDialog open={confirmCloseAll} onOpenChange={setConfirmCloseAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('connections.closeAllTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('connections.closeAllWarn')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('connections.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleCloseAll}>
              {t('connections.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
