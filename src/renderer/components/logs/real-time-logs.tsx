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
  const [isAutoScroll, setIsAutoScroll] = useState(true); // 默认自动滚动：打开日志页即跟随最新（上滚脱离、回底吸附逻辑不变）
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const userScrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // 防自指：effect ④ 程序化滚到底会触发 scroll 事件，若被 handleScroll 当成"用户滚动"会反推 isAutoScroll
  // → 形成反馈环（高日志量下开关失灵、关不掉一直滚）。置位后忽略该次（及本帧内）滚动事件，只有真·用户滚动才更新状态。
  const suppressScrollHandlerRef = useRef(false);
  const nextIdRef = useRef(0);
  const maxBufferRef = useRef(maxBuffer);
  const connectionStatus = useAppStore((state) => state.connectionStatus);

  // Effect ①：实时日志订阅 —— 仅挂载时订阅一次；容量经 maxBufferRef 读取，props 变化不重订阅。
  useEffect(() => {
    const handleLogReceived = (logEntry: LogEntry) => {
      setLogs((prev) =>
        [...prev, { ...logEntry, _id: nextIdRef.current++ }].slice(-maxBufferRef.current)
      );
    };
    const unsubscribe = addEventListener('logReceived', handleLogReceived);
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

  // 监听滚动事件
  useEffect(() => {
    const scrollElement = getScrollElement();
    if (!scrollElement) return;

    const handleScroll = () => {
      // 防自指：本次 scroll 由 effect ④ 程序化滚到底触发 → 消费并忽略，不更新 isAutoScroll/isUserScrolling（断反馈环）。
      if (suppressScrollHandlerRef.current) {
        suppressScrollHandlerRef.current = false;
        return;
      }
      // 标记用户正在滚动
      setIsUserScrolling(true);

      // 清除之前的超时
      if (userScrollTimeoutRef.current) {
        clearTimeout(userScrollTimeoutRef.current);
      }

      // 设置超时，滚动停止后更新状态
      userScrollTimeoutRef.current = setTimeout(() => {
        setIsUserScrolling(false);
        // 检查是否滚动到底部
        const atBottom = checkIsAtBottom(scrollElement);
        setIsAutoScroll(atBottom);
      }, 150);
    };

    scrollElement.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      scrollElement.removeEventListener('scroll', handleScroll);
      if (userScrollTimeoutRef.current) {
        clearTimeout(userScrollTimeoutRef.current);
      }
    };
  }, [getScrollElement, checkIsAtBottom]);

  // 只有在自动滚动模式且用户没有主动滚动时才自动滚动到底部
  useEffect(() => {
    if (!isAutoScroll || isUserScrolling) return;
    const scrollElement = getScrollElement();
    if (!scrollElement) return;
    // 置位防自指标志 → 这次程序化滚动产生的 scroll 事件被 handleScroll 消费忽略，不反推 isAutoScroll（断反馈环）。
    suppressScrollHandlerRef.current = true;
    scrollElement.scrollTop = scrollElement.scrollHeight;
    // 兜底：若已在底部、scrollTop 无位移 → 不触发 scroll 事件 → 下一帧清标志，避免误吞下次真·用户滚动。
    // 与本组件惯例一致：捕获 rafId 并在 cleanup 取消（高日志量下避免堆积未触发的帧回调）。
    const rafId = requestAnimationFrame(() => {
      suppressScrollHandlerRef.current = false;
    });
    return () => cancelAnimationFrame(rafId);
  }, [logs, isAutoScroll, isUserScrolling, getScrollElement]);

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
        return 'text-gray-500';
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
          <div className="flex items-center space-x-2">
            <div className="relative">
              <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder={t('home.searchLogs')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="h-8 w-[160px] pl-8 text-xs"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearLogs}
              disabled={logs.length === 0}
            >
              <Trash2 className="h-4 w-4 mr-1" />
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
                    <span className={`ml-2 font-semibold ${getLevelColor(log.level)}`}>
                      {log.level.toUpperCase()}:
                    </span>
                    <span className="ml-2">{log.message}</span>
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
                const scrollElement = getScrollElement();
                if (scrollElement) {
                  scrollElement.scrollTop = scrollElement.scrollHeight;
                }
              }}
              className="text-xs h-7"
            >
              <ArrowDown className="h-3 w-3 mr-1" />
              {t('home.scrollToBottom')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
