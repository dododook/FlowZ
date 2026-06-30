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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
import {
  Activity,
  Search,
  Pause,
  Play,
  X,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Ban,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc';
import { toast } from 'sonner';
import { formatBytes } from '@/lib/format';
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
  type ConnSpeed,
  type RateState,
} from './connection-utils';

type SortKey = 'type' | 'source' | 'dest' | 'rule' | 'chain' | 'speed' | 'traffic' | 'time';
type SortDir = 'asc' | 'desc';

/** 规则去向 action → Badge 配色：direct 中性灰 / block 系危险红 / 其它(proxy·具体节点) 主色。 */
function ruleActionVariant(action: string): 'secondary' | 'destructive' | 'default' {
  const a = action.toLowerCase();
  if (a === 'direct') return 'secondary';
  if (a === 'block' || a === 'reject' || a === 'reject-drop' || a === 'drop') return 'destructive';
  return 'default';
}

/** 稳定的零速率引用：speeds 无此 id 时传入，使 ConnectionRow memo 的 speed 比较恒定（不每帧新建对象）。 */
const ZERO_SPEED: ConnSpeed = { up: 0, down: 0 };

/** 连接明细 pull 间隔（issue #227）：本页打开期间每隔此时长拉一次 CONNECTIONS_GET，取代旧「每秒全量 push 给
 *  所有窗口」订阅——连接明细成本仅在用户主动查看本页时产生，且页面关闭即停。对齐旧 push 的 1s 节奏（连接页仅
 *  打开时拉，1s 无额外负担），关连接另有乐观更新即时反馈，不依赖本间隔。 */
const PULL_INTERVAL_MS = 1000;

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
    return (
      <TableRow>
        <TableCell className="py-2">
          <button
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            title={closeLabel}
            onClick={() => onClose(c.id)}
          >
            <X className="h-4 w-4" />
          </button>
        </TableCell>
        <TableCell className="py-2 text-xs">{typeOf(c)}</TableCell>
        <TableCell className="py-2 font-mono tabular-nums text-xs">{sourceOf(c)}</TableCell>
        <TableCell className="max-w-[220px] truncate py-2 font-mono text-xs" title={destOf(c)}>
          {destOf(c)}
        </TableCell>
        <TableCell className="max-w-[200px] py-2 text-xs" title={rv.full || undefined}>
          {rv.action ? (
            <span className="flex items-center gap-1.5">
              {rv.type && <span className="truncate text-muted-foreground">{rv.type}</span>}
              <Badge
                variant={ruleActionVariant(rv.action)}
                className="shrink-0 px-1.5 py-0 text-[10px] font-normal"
              >
                {rv.action}
              </Badge>
            </span>
          ) : (
            <span className="block truncate">{rv.full || '-'}</span>
          )}
        </TableCell>
        <TableCell className="max-w-[160px] truncate py-2 text-xs" title={chainOf(c)}>
          {chainOf(c)}
        </TableCell>
        <TableCell className="whitespace-nowrap py-2 font-mono tabular-nums text-xs">
          <span className="text-success">↓ {formatBytes(s.down)}/s</span>
          <span className="ms-2 text-info">↑ {formatBytes(s.up)}/s</span>
        </TableCell>
        <TableCell className="whitespace-nowrap py-2 font-mono tabular-nums text-xs text-muted-foreground">
          ↓ {formatBytes(c.download ?? 0)} / ↑ {formatBytes(c.upload ?? 0)}
        </TableCell>
        <TableCell className="whitespace-nowrap py-2 font-mono tabular-nums text-xs">
          <DurationCell start={c.start} />
        </TableCell>
        <TableCell className="max-w-[180px] truncate py-2 text-xs" title={proc}>
          {procName}
        </TableCell>
      </TableRow>
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

  // 暂停态用 ref 让订阅回调读到最新值（订阅只挂一次，不随 paused 重订阅）。
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  // per-conn 速率差分的上一帧缓存（不入 state，避免无谓重渲染）。
  const rateRef = useRef<RateState>(new Map());
  // pull in-flight 守卫（review Low-B）：慢主进程/Windows 拖动期 setInterval 仍每秒派发，防 CONNECTIONS_GET
  // 叠加排队、drag-end 一并 flush 的瞬时尖峰。
  const inFlightRef = useRef(false);

  // 数据（issue #227）：连接明细改【按需 pull】——本页打开期间每 PULL_INTERVAL_MS 拉一次 CONNECTIONS_GET，
  // 不再订阅每秒全量 push。暂停 / 窗口隐藏时停拉（冻结当前帧 + 不推进速率基准）；页面卸载清 interval，无残留。
  useEffect(() => {
    let mounted = true;
    const apply = (snap: ConnectionsSnapshot) => {
      const { speeds: s, next } = computeConnSpeeds(snap.connections, rateRef.current, snap.at);
      rateRef.current = next;
      setSpeeds(s);
      setConnections(snap.connections);
    };
    const pull = () => {
      // 暂停 / 窗口隐藏：跳过拉取（无 UI 消费者；对齐 main 侧 isUiBroadcastActive 可见性门控，省隐藏期每秒
      // CONNECTIONS_GET 的主线程 IPC + 序列化开销，review Med）。拖动期对齐需 main 推拖动态 → 记真机监控项。
      // in-flight 守卫（Low-B）：上一次未 resolve 不叠加，防慢主进程/拖动期排队积压。
      if (pausedRef.current || document.hidden || inFlightRef.current) return;
      inFlightRef.current = true;
      api.connections
        .get()
        .then((snap) => {
          // 在途结果若期间已暂停则丢弃（gate 上移到 pull 后，apply 不再自查 paused，Low-A）。
          if (mounted && !pausedRef.current) apply(snap);
        })
        .catch(() => {
          /* 静默：核未运行 / 鉴权未就绪，空态由 proxyRunning gate 兜底 */
        })
        .finally(() => {
          inFlightRef.current = false;
        });
    };
    pull(); // 挂载即拉一次（回填初值）
    const timer = setInterval(pull, PULL_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

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
  // 超过软上限只渲染前 N 行并提示用搜索缩小（shadcn <table> 语义下真虚拟化需破坏表结构、收益有限，取此务实方案）。
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

  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sortKey !== k) return <ArrowUpDown className="ms-1 inline h-3 w-3 opacity-40" />;
    return sortDir === 'asc' ? (
      <ArrowUp className="ms-1 inline h-3 w-3" />
    ) : (
      <ArrowDown className="ms-1 inline h-3 w-3" />
    );
  };

  const headerCell = (k: SortKey, label: string, className?: string) => (
    <TableHead
      className={`cursor-pointer select-none whitespace-nowrap ${className ?? ''}`}
      onClick={() => toggleSort(k)}
    >
      {label}
      <SortIcon k={k} />
    </TableHead>
  );

  return (
    <div className="space-y-3">
      {/* 顶栏：连接数 + 搜索 + 暂停/恢复 + 全部关闭 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">
          {t('connections.count', { count: connections.length })}
        </span>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute start-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder={t('connections.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-[200px] ps-8 text-xs"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => setPaused((p) => !p)}>
            {paused ? (
              <>
                <Play className="me-1 h-4 w-4" />
                {t('connections.resume')}
              </>
            ) : (
              <>
                <Pause className="me-1 h-4 w-4" />
                {t('connections.pause')}
              </>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmCloseAll(true)}
            disabled={connections.length === 0}
          >
            <Ban className="me-1 h-4 w-4" />
            {t('connections.closeAll')}
          </Button>
        </div>
      </div>

      {/* 表 / 空态 */}
      <div className="rounded-lg border bg-muted/40">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
            <Activity className="h-8 w-8 opacity-50" />
            <span>
              {connections.length > 0 && search
                ? t('connections.noMatch')
                : proxyRunning
                  ? t('connections.noActive')
                  : t('connections.plsStartProxy')}
            </span>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                {headerCell('type', t('connections.colType'))}
                {headerCell('source', t('connections.colSource'))}
                {headerCell('dest', t('connections.colDest'))}
                {headerCell('rule', t('connections.colRule'))}
                {headerCell('chain', t('connections.colChain'))}
                {headerCell('speed', t('connections.colSpeed'))}
                {headerCell('traffic', t('connections.colTraffic'))}
                {headerCell('time', t('connections.colTime'))}
                <TableHead className="whitespace-nowrap">{t('connections.colProcess')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((c) => (
                <ConnectionRow
                  key={c.id}
                  conn={c}
                  speed={speeds.get(c.id) ?? ZERO_SPEED}
                  onClose={handleClose}
                  closeLabel={t('connections.close')}
                />
              ))}
              {filtered.length > MAX_VISIBLE_ROWS && (
                <TableRow>
                  <TableCell
                    colSpan={10}
                    className="py-2 text-center text-xs text-muted-foreground"
                  >
                    {t('connections.rowsTruncated', {
                      shown: MAX_VISIBLE_ROWS,
                      total: filtered.length,
                    })}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
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
    </div>
  );
}
