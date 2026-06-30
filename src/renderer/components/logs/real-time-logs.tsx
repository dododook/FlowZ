import { useEffect, useRef, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { useAppStore } from '@/store/app-store';
import { Trash2, ArrowDown, Search } from 'lucide-react';
import { getLogs, clearLogs, addEventListener } from '@/bridge/api-wrapper';
import type { LogEntry } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

/** 渲染端为每条日志附加单调自增 _id 作为稳定 key —— 环形缓冲淘汰首元素后剩余项 key 不变，
 *  避免 key={index} 错位导致滚动期全量重渲染并打断文本选区。 */
type LogRow = LogEntry & { _id: number; historical?: true };

interface RealTimeLogsProps {
  /** Tailwind height class for the scroll viewport. Defaults to fixed h-64 (home card). */
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
  // 吸附底部（默认开）：进页即定位到底并跟随最新；用户上滚脱离底部即停跟随，滚回底部即恢复。
  const [isAutoScroll, setIsAutoScroll] = useState(true);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  // 进页「定位到底」只做一次（等首批历史日志渲染 + radix viewport 布局就绪）。
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
        return next.slice(-maxBufferRef.current);
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
            [...initial, ...prev.filter((r) => !r.historical)].slice(-maxBufferRef.current)
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
    setLogs((prev) => (prev.length > maxBuffer ? prev.slice(-maxBuffer) : prev));
  }, [maxBuffer]);

  // 获取滚动元素
  const getScrollElement = useCallback(() => {
    return scrollAreaRef.current?.querySelector(
      '[data-radix-scroll-area-viewport]'
    ) as HTMLElement | null;
  }, []);

  // 检查是否在底部
  const checkIsAtBottom = useCallback((element: HTMLElement) => {
    const threshold = 30; // 距离底部30px以内认为在底部
    return element.scrollTop + element.clientHeight >= element.scrollHeight - threshold;
  }, []);

  // 滚到底部（程序化）。
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

  // 新日志到达：吸附底部时跟随滚到底；脱离底部则保持不动。
  useEffect(() => {
    if (isAutoScroll) scrollToBottom();
  }, [logs, isAutoScroll, scrollToBottom]);

  // 进页定位到底（修「点进实时日志默认不在底部」）：等首批日志渲染 + radix viewport 布局完成（双 rAF）后滚一次。
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

  const getLevelColor = (level: LogEntry['level']) => {
    switch (level) {
      case 'error':
        return 'text-destructive';
      case 'warn':
        return 'text-warning';
      case 'info':
        return 'text-info';
      case 'debug':
        return 'text-muted-foreground';
      default:
        return 'text-foreground';
    }
  };

  const filteredLogs = logs.filter(
    (log) =>
      log.message.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.level.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{t('home.realTimeLogs')}</CardTitle>
          <div className="flex items-center space-x-2 rtl:space-x-reverse">
            <div className="relative">
              <Search className="absolute start-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder={t('home.searchLogs')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="h-8 w-[160px] ps-8 text-xs"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearLogs}
              disabled={logs.length === 0}
            >
              <Trash2 className="h-4 w-4 me-1" />
              {t('home.clear')}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea
          ref={scrollAreaRef}
          className={`${heightClass} w-full rounded border bg-muted/30 p-3`}
        >
          {filteredLogs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              {logs.length > 0 && searchTerm
                ? t('home.noLogsMatch')
                : connectionStatus?.proxyCore?.running
                  ? t('home.waitingForLogs')
                  : t('home.plsStartProxy')}
            </div>
          ) : (
            <div className="space-y-1 select-text cursor-text">
              {filteredLogs.map((log) => {
                const timestamp = new Date(log.timestamp).toLocaleTimeString(i18n.language);

                return (
                  <div key={log._id} className="text-xs font-mono select-text">
                    <span className="text-muted-foreground">[{timestamp}]</span>
                    <span className={`ms-2 font-semibold ${getLevelColor(log.level)}`}>
                      {log.level.toUpperCase()}:
                    </span>
                    <span className="ms-2">{log.message}</span>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>

        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {isAutoScroll ? t('home.autoScrollOn') : t('home.autoScrollOff')}
          </span>
          {!isAutoScroll && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsAutoScroll(true);
                scrollToBottom();
              }}
              className="text-xs h-7"
            >
              <ArrowDown className="h-3 w-3 me-1" />
              {t('home.scrollToBottom')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
