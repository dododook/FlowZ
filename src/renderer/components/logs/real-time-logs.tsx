import { useEffect, useRef, useState, useCallback } from 'react';
import { HighlightText } from '@/components/ui/highlight-text';
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
import { useAppStore } from '@/store/app-store';
import { ArrowDown } from 'lucide-react';
import { getLogs, clearLogs, addEventListener } from '@/bridge/api-wrapper';
import type { LogEntry } from '@/bridge/types';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { logMatchesSearch, truncateToBuffer } from './real-time-logs-logic';

/** 渲染端为每条日志附加单调自增 _id 作为稳定 key —— 环形缓冲淘汰首元素后剩余项 key 不变，
 *  避免 key={index} 错位导致滚动期全量重渲染并打断文本选区。 */
type LogRow = LogEntry & { _id: number; historical?: true };

interface RealTimeLogsProps {
  /** Tailwind height class for the log-viewer card (bounds `.lv-stream` internal scroll). Defaults to h-64. */
  heightClass?: string;
  /** How many historical lines to load on mount. */
  initialLimit?: number;
  /** Max in-memory ring-buffer size for live tail. */
  maxBuffer?: number;
}

export function RealTimeLogs({
  heightClass = 'h-64',
  initialLimit = 50,
  maxBuffer = 100,
}: RealTimeLogsProps = {}) {
  const { t, i18n } = useTranslation();
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  // 清空为高危不可逆操作（丢失内存中的实时日志缓冲）→ 二次确认后才执行。
  const [confirmClear, setConfirmClear] = useState(false);
  // 吸附底部（默认开）：进页即定位到底并跟随最新；用户上滚脱离底部即停跟随，滚回底部即恢复。
  const [isAutoScroll, setIsAutoScroll] = useState(true);
  // `.lv-stream` 自身即滚动容器（替代原 radix ScrollArea + viewport 查询）。
  const streamRef = useRef<HTMLDivElement>(null);
  // 进页「定位到底」只做一次（等首批历史日志渲染 + 布局就绪）。
  const didInitScrollRef = useRef(false);
  const nextIdRef = useRef(0);
  const maxBufferRef = useRef(maxBuffer);
  const connectionStatus = useAppStore((state) => state.connectionStatus);

  // Effect ①：实时日志订阅 —— 仅挂载时订阅一次；容量经 maxBufferRef 读取，props 变化不重订阅。
  // T1（issue #225）：改订阅批量通道 'logReceivedBatch'（主进程 ~150ms coalesce），一批日志单次 setState 追加，
  // 取代逐条 setState（启动期洪流下逐条 = 高频重渲 + RDP 逐帧流式，拖动卡顿主因之一）。
  useEffect(() => {
    const handleLogBatch = (entries: LogEntry[]) => {
      if (!entries || entries.length === 0) return;
      setLogs((prev) => {
        const next = prev.slice();
        for (const e of entries) next.push({ ...e, _id: nextIdRef.current++ });
        return truncateToBuffer(next, maxBufferRef.current);
      });
    };
    const unsubscribe = addEventListener('logReceivedBatch', handleLogBatch);
    return unsubscribe;
  }, []);

  // Effect ②：历史日志加载 —— 仅依赖 initialLimit；重载时剔除上一轮 historical 段再 prepend（替换而非重复）。
  useEffect(() => {
    // stale 守卫：StrictMode 双触发 / 卸载 / initialLimit 竞速时丢弃过期结果，
    // 避免重复 prepend 与 setState-after-unmount。
    let stale = false;

    const loadInitialLogs = async () => {
      try {
        const response = await getLogs(initialLimit);
        if (stale) return;
        if (response && response.success && response.data) {
          const initial: LogRow[] = response.data.map((entry: LogEntry) => ({
            ...entry,
            _id: nextIdRef.current++,
            historical: true,
          }));
          // 历史段置于 live 段之前；剔除旧 historical 实现「重载即替换」，对 live 先到 / StrictMode 双触发均幂等。
          setLogs((prev) =>
            truncateToBuffer(
              [...initial, ...prev.filter((r) => !r.historical)],
              maxBufferRef.current
            )
          );
        }
      } catch (error) {
        console.error('Failed to load initial logs:', error);
      }
    };

    loadInitialLogs();

    return () => {
      stale = true;
    };
  }, [initialLimit]);

  // Effect ③：maxBuffer 变更 —— 只重切现有 state，不重载历史、不重订阅。
  useEffect(() => {
    maxBufferRef.current = maxBuffer;
    setLogs((prev) => truncateToBuffer(prev, maxBuffer));
  }, [maxBuffer]);

  const getScrollElement = useCallback(() => streamRef.current, []);

  const checkIsAtBottom = useCallback((element: HTMLElement) => {
    const threshold = 30; // 距离底部30px以内认为在底部
    return element.scrollTop + element.clientHeight >= element.scrollHeight - threshold;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = getScrollElement();
    if (el) el.scrollTop = el.scrollHeight;
  }, [getScrollElement]);

  // 监听用户滚动：直接据「是否贴底」更新吸附状态。程序化滚到底 → 贴底=true → setState 幂等、无反馈环；
  // 用户上滚脱离 → false → 停止跟随；滚回底部 → true → 恢复。较原 suppress+debounce 更稳：高日志量下不再
  // 误吞用户滚动、关不掉一直滚（修「上滚到顶仍自动滚」）。
  useEffect(() => {
    const el = getScrollElement();
    if (!el) return;
    const onScroll = () => setIsAutoScroll(checkIsAtBottom(el));
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [getScrollElement, checkIsAtBottom]);

  useEffect(() => {
    if (isAutoScroll) scrollToBottom();
  }, [logs, isAutoScroll, scrollToBottom]);

  // 进页定位到底（修「点进实时日志默认不在底部」）：等首批日志渲染 + 布局完成（双 rAF）后滚一次。
  // 条件渲染（App.tsx currentView==='logs' && …）下每次进页都重挂载 → 每次重新定位到底。
  useEffect(() => {
    if (didInitScrollRef.current || logs.length === 0) return;
    didInitScrollRef.current = true;
    let r2 = 0;
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(scrollToBottom);
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, [logs, scrollToBottom]);

  const handleClearLogs = async () => {
    try {
      const success = await clearLogs();
      if (success) {
        setLogs([]);
      }
    } catch (error) {
      console.error('Failed to clear logs:', error);
      // Clear local logs anyway
      setLogs([]);
    }
  };

  const filteredLogs = logs.filter((log) => logMatchesSearch(log, searchTerm));

  return (
    // 外层裸容器定高（heightClass），card 用 h-full 填满 → `.lv-stream` 内部滚动。
    // 不直接把 heightClass 挂到 `.log-viewer`：conduit 未分层的 `.log-viewer{flex:1;flex-basis:0%}`
    // 会盖过 tailwind 分层 utility，在非定高父级下把卡压塌；h-full(height:100%) 对定高父级稳定解析。
    <div className={heightClass}>
      <div className="card log-viewer h-full">
        <div className="lv-bar">
          <div className="lv-search">
            <svg
              className="lv-search-ic"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4-4" strokeLinecap="round" />
            </svg>
            <input
              className="input"
              type="text"
              placeholder={t('home.searchLogs') as string}
              aria-label={t('home.searchLogs') as string}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setConfirmClear(true)}
            disabled={logs.length === 0}
          >
            {t('home.clear')}
          </button>
        </div>

        {/* 日志流：容器自身滚动（等宽 mono），级别形+色经 CSS `.lg[data-lvl]` */}
        <div
          className="lv-stream mono"
          tabIndex={0}
          role="log"
          aria-label={t('home.realTimeLogs') as string}
          ref={streamRef}
        >
          {filteredLogs.length === 0 ? (
            <div className="lv-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path
                  d="M4 13h4l2 3h4l2-3h4M5 13V6a2 2 0 012-2h10a2 2 0 012 2v7M4 13v4a2 2 0 002 2h12a2 2 0 002-2v-4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {/* 空态三形态：无匹配 / 等待日志 / 未启动（原 3 分支保留） */}
              <b className="lv-empty-t">
                {logs.length > 0 && searchTerm
                  ? t('home.noLogsMatch')
                  : connectionStatus?.proxyCore?.running
                    ? t('home.waitingForLogs')
                    : t('home.plsStartProxy')}
              </b>
            </div>
          ) : (
            filteredLogs.map((log) => {
              const timestamp = new Date(log.timestamp).toLocaleTimeString(i18n.language);
              return (
                <div key={log._id} className="lg" data-lvl={log.level}>
                  <span className="lg-t">[{timestamp}]</span>
                  <span className="lg-l">{log.level.toUpperCase()}:</span>
                  <span className="lg-m">
                    <HighlightText text={log.message} query={searchTerm} />
                  </span>
                </div>
              );
            })
          )}
        </div>

        <div className="lv-foot">
          <span className="lv-follow">
            <span className={cn('dot', isAutoScroll ? 'ok' : 'idle')} />
            <span className="lv-follow-t">
              {isAutoScroll ? t('home.autoScrollOn') : t('home.autoScrollOff')}
            </span>
          </span>
          <span className="lv-foot-r">
            <span
              className="lv-lines mono tnum"
              title={
                searchTerm
                  ? (t('home.logLinesFilteredTitle', '命中 / 缓冲总行数') as string)
                  : undefined
              }
            >
              {searchTerm
                ? t('home.logLinesFiltered', {
                    defaultValue: '{{shown}} / {{total}}',
                    shown: filteredLogs.length,
                    total: logs.length,
                  })
                : t('home.logLines', { count: filteredLogs.length })}
            </span>
            {!isAutoScroll && (
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  setIsAutoScroll(true);
                  scrollToBottom();
                }}
              >
                <ArrowDown className="h-3 w-3" />
                {t('home.scrollToBottom')}
              </button>
            )}
          </span>
        </div>

        {/* 清空日志高危二次确认（统一 alert-dialog pattern，对齐「连接全部关闭 / 删除节点」等） */}
        <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('home.clearLogsTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('home.clearLogsWarn')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleClearLogs}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {t('home.clear')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
