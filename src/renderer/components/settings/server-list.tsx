import { useState, useMemo, useEffect } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Plus,
  Edit,
  Trash2,
  Server,
  ChevronDown,
  LayoutGrid,
  List,
  Search,
  ArrowUpDown,
  CheckSquare,
  Square,
  Copy,
  CopyPlus,
  Zap,
  Link,
} from 'lucide-react';
import { ImportUrlDialog } from './import-url-dialog';
import { generateShareUrl } from '@/bridge/api-wrapper';
import { api } from '@/ipc/api-client';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { getSortedProtocolOptions } from './shared/protocol-options';
import {
  isAccountBasedProtocol,
  isEndpointProtocol,
  meshAllowsInternet,
} from '../../../shared/endpoint-routes';

type ServerConfigWithId = ServerConfig;
type ViewMode = 'card' | 'list';

/** 无分享链接的协议（ProtocolParser.generateUrl 无对应分支）：隐藏/排除复制按钮，避免 per-server 抛错刷屏。 */
const NO_SHARE_LINK_PROTOCOLS = new Set(['ssh', 'wireguard', 'tailscale', 'custom']);
const hasShareLink = (protocol: string | undefined): boolean =>
  !NO_SHARE_LINK_PROTOCOLS.has(protocol?.toLowerCase() || '');
type SortKey = 'name' | 'protocol' | 'latency' | 'address';
type SortOrder = 'asc' | 'desc';

const getCountryCode = (name: string): string | null => {
  const lowerName = name.toLowerCase();
  // 拉丁字母国家码/缩写要求两侧不与其他字母相邻（允许数字/分隔符），以免子串误判：
  // russia 含 us、berlin 含 in、montreal 含 tr、sweden 含 de、madrid 含 id 等；
  // 同时兼容 "US01" / "HK-02" 等写法。中文名/城市/旗帜 emoji 足够独特，仍按子串匹配。
  if (/香港|🇭🇰|hong kong|(?<![a-z])hk(?![a-z])/.test(lowerName)) return 'hk';
  if (/台湾|🇹🇼|台北|新北|(?<![a-z])(?:tw|taiwan)(?![a-z])/.test(lowerName)) return 'cn';
  if (/日本|🇯🇵|东京|大阪|(?<![a-z])(?:jp|japan)(?![a-z])/.test(lowerName)) return 'jp';
  if (/新加坡|🇸🇬|狮城|(?<![a-z])(?:sg|singapore)(?![a-z])/.test(lowerName)) return 'sg';
  if (/美国|🇺🇸|洛杉矶|硅谷|西雅图|(?<![a-z])(?:us|usa|america)(?![a-z])/.test(lowerName))
    return 'us';
  if (/韩国|🇰🇷|首尔|(?<![a-z])(?:kr|korea)(?![a-z])/.test(lowerName)) return 'kr';
  if (/英国|🇬🇧|伦敦|(?<![a-z])(?:uk|gb)(?![a-z])/.test(lowerName)) return 'gb';
  if (/德国|🇩🇪|法兰克福|(?<![a-z])(?:de|germany)(?![a-z])/.test(lowerName)) return 'de';
  if (/法国|🇫🇷|巴黎|(?<![a-z])(?:fr|france)(?![a-z])/.test(lowerName)) return 'fr';
  if (/澳洲|澳大利亚|🇦🇺|悉尼|(?<![a-z])(?:au|australia)(?![a-z])/.test(lowerName)) return 'au';
  if (/加拿大|🇨🇦|多伦多|温哥华|(?<![a-z])(?:ca|canada)(?![a-z])/.test(lowerName)) return 'ca';
  if (/印度|🇮🇳|孟买|(?<![a-z])(?:in|india)(?![a-z])/.test(lowerName)) return 'in';
  if (/俄罗斯|🇷🇺|莫斯科|(?<![a-z])(?:ru|russia)(?![a-z])/.test(lowerName)) return 'ru';
  if (/荷兰|🇳🇱|阿姆斯特丹|(?<![a-z])(?:nl|netherlands)(?![a-z])/.test(lowerName)) return 'nl';
  if (/土耳其|🇹🇷|伊斯坦布尔|(?<![a-z])(?:tr|turkey)(?![a-z])/.test(lowerName)) return 'tr';
  if (/阿根廷|🇦🇷|(?<![a-z])(?:ar|argentina)(?![a-z])/.test(lowerName)) return 'ar';
  if (/意大利|🇮🇹|罗马|米兰|(?<![a-z])(?:it|italy)(?![a-z])/.test(lowerName)) return 'it';
  if (/巴西|🇧🇷|圣保罗|(?<![a-z])(?:br|brazil)(?![a-z])/.test(lowerName)) return 'br';
  if (/西班牙|🇪🇸|马德里|(?<![a-z])(?:es|spain)(?![a-z])/.test(lowerName)) return 'es';
  if (/瑞士|🇨🇭|苏黎世|(?<![a-z])(?:ch|switzerland)(?![a-z])/.test(lowerName)) return 'ch';
  if (/瑞典|🇸🇪|斯德哥尔摩|(?<![a-z])(?:se|sweden)(?![a-z])/.test(lowerName)) return 'se';
  if (/印尼|印度尼西亚|🇮🇩|雅加达|(?<![a-z])(?:id|indonesia)(?![a-z])/.test(lowerName)) return 'id';
  if (/马来西亚|🇲🇾|吉隆坡|(?<![a-z])(?:my|malaysia)(?![a-z])/.test(lowerName)) return 'my';
  return null;
};

/** 传输层显示标签：QUIC 系协议(hysteria2/tuic/naive-HTTP3)统一显示 udp，其余按 network；缺省 tcp。 */
const getTransportLabel = (server: ServerConfigWithId): string => {
  const p = server.protocol?.toLowerCase();
  if (p === 'hysteria2' || p === 'tuic' || p === 'wireguard') return 'udp';
  if (p === 'tailscale') return 'mesh';
  if (p === 'naive') return server.naiveSettings?.useHttp3 ? 'udp' : 'tcp';
  return server.network || 'tcp';
};

/** WARP 节点（一键生成的 wireguard，端点为 Cloudflare WARP relay）。无需持久标记，按端点域名判，缺则不显示。 */
const isWarpNode = (s: ServerConfigWithId): boolean =>
  s.protocol?.toLowerCase() === 'wireguard' &&
  (s.address || '').toLowerCase().includes('cloudflareclient.com');

/** Tailscale 节点未配置 authKey → 首次连接需浏览器交互登录，列表给提示角标降低「为何连不上」的困惑。 */
const tailscaleNeedsLogin = (s: ServerConfigWithId): boolean =>
  s.protocol?.toLowerCase() === 'tailscale' && !s.tailscaleSettings?.authKey?.trim();

/** 组网节点（WG/Tailscale）已关闭「允许访问外网」→ 列表角标提示「仅内网」，避免误以为它能作全局出口。 */
const meshInternetOff = (s: ServerConfigWithId): boolean =>
  isEndpointProtocol(s.protocol) && !meshAllowsInternet(s);

interface ServerListProps {
  servers: ServerConfigWithId[];
  selectedServerId?: string;
  showAddButton?: boolean;
  onAddServer: () => void;
  onEditServer: (server: ServerConfigWithId) => void;
  onDeleteServer: (serverId: string) => void;
  onDeleteServers?: (serverIds: string[]) => void;
  onCloneServer?: (server: ServerConfigWithId) => void;
  onSelectServer: (serverId: string) => void;
  onImportSuccess?: () => void;
}

export function ServerList({
  servers,
  selectedServerId,
  showAddButton = true,
  onAddServer,
  onEditServer,
  onDeleteServer,
  onDeleteServers,
  onCloneServer,
  onSelectServer,
  onImportSuccess,
}: ServerListProps) {
  const latencyMap = useAppStore((state) => state.latencyMap);
  const setLatencyMap = useAppStore((state) => state.setLatencyMap);
  // 启动前配置校验 gate 剔除的非法节点：列表标灰 + tooltip（不禁用点击，用户仍可选/编辑/删除）。
  const invalidNodes = useAppStore((state) => state.invalidNodes);
  const [isTestingSpeed, setIsTestingSpeed] = useState(false);
  const [speedProgress, setSpeedProgress] = useState<{
    tested: number;
    ok: number;
    total: number;
  } | null>(null);
  const [testingServerIds, setTestingServerIds] = useState<Set<string>>(new Set());
  const { t, i18n } = useTranslation();

  // 记住用户的视图偏好
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('flowz_server_view_mode');
    return saved === 'card' || saved === 'list' ? saved : 'card';
  });

  useEffect(() => {
    localStorage.setItem('flowz_server_view_mode', viewMode);
  }, [viewMode]);

  // 搜索 / 过滤 / 排序
  const [searchQuery, setSearchQuery] = useState('');
  const [filterProtocol, setFilterProtocol] = useState<string>('all');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

  // 批量选择
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSelecting, setIsSelecting] = useState(false);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);

  const handleSpeedTest = async () => {
    setIsTestingSpeed(true);
    // 订阅声明在 try 外，确保 catch/finally 路径都能 unsubscribe（防 listener 泄漏：测速失败时曾漏清）。
    const unsubscribeResult = api.server.onSpeedTestResult(({ serverId, latency }) => {
      setLatencyMap((prev) => ({ ...prev, [serverId]: latency }));
    });
    const unsubscribeProgress = api.server.onSpeedTestProgress(({ tested, ok, total }) => {
      setSpeedProgress({ tested, ok, total });
    });
    try {
      toast.info(t('servers.speedTestStart'));
      const serverIdsToTest = servers.map((s) => s.id);
      const results = await api.server.speedTest(serverIdsToTest);
      // 末尾兜底同步（确保最终结果一致，兜底事件丢失）；函数式合并保留未测节点的历史延迟。
      setLatencyMap((prev) => ({ ...prev, ...results }));
      toast.success(t('servers.speedTestDone'));
      // 不再自动排序（保留用户排序偏好，测速只更新延迟值）
    } catch (error) {
      toast.error(t('servers.speedTestFail'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      unsubscribeResult();
      unsubscribeProgress();
      setIsTestingSpeed(false);
      setSpeedProgress(null);
    }
  };

  const handleSingleSpeedTest = async (serverId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTestingServerIds((prev) => {
      const s = new Set(prev);
      s.add(serverId);
      return s;
    });
    try {
      const results = await api.server.speedTest([serverId]);

      // Update only this specific node's latency in the store（函数式合并，避免 stale 覆盖）
      setLatencyMap((prev) => ({ ...prev, ...results }));

      if (results[serverId] !== undefined) {
        toast.success(t('servers.speedTestDone'));
      }
    } catch (error) {
      toast.error(t('servers.speedTestFail'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTestingServerIds((prev) => {
        const s = new Set(prev);
        s.delete(serverId);
        return s;
      });
    }
  };

  // 账号制协议（Tailscale）无 server address/port；自定义协议 server/port 在 JSON 内（缺则显类型）——
  // 卡片副标题不展示 `undefined:undefined`。
  const endpointLabel = (server: ServerConfigWithId): string => {
    if (isAccountBasedProtocol(server.protocol)) return `Tailscale · ${getTransportLabel(server)}`;
    if (server.protocol?.toLowerCase() === 'custom' && !server.address) {
      const type = (server.customSettings?.outbound as any)?.type;
      return `Custom · ${type || 'json'}`;
    }
    return `${server.address}:${server.port}`;
  };

  const getLatencyColor = (latency: number | undefined) => {
    if (latency === undefined) return 'text-muted-foreground';
    if (latency === -1) return 'text-destructive';
    if (latency < 100) return 'text-success';
    if (latency < 300) return 'text-warning';
    return 'text-destructive';
  };

  const getLatencyBg = (latency: number | undefined) => {
    if (latency === undefined) return '';
    if (latency === -1) return 'bg-destructive/10';
    if (latency < 100) return 'bg-success/10';
    if (latency < 300) return 'bg-warning/10';
    return 'bg-destructive/10';
  };

  const handleDelete = (serverId: string) => {
    onDeleteServer(serverId);
    setSelectedIds((prev) => {
      const s = new Set(prev);
      s.delete(serverId);
      return s;
    });
  };

  const handleBatchDelete = () => {
    if (onDeleteServers) {
      onDeleteServers(Array.from(selectedIds));
    } else {
      selectedIds.forEach((id) => onDeleteServer(id));
    }
    setSelectedIds(new Set());
    setIsSelecting(false);
  };

  const handleCopyShareUrl = async (server: ServerConfigWithId, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const response = await generateShareUrl(server);
      if (response.success && response.data) {
        await navigator.clipboard.writeText(response.data);
        toast.success(t('servers.shareUrlCopied'));
      } else {
        toast.error(response.error || t('servers.shareUrlFail'));
      }
    } catch {
      toast.error(t('common.copyFail'));
    }
  };

  const handleBatchCopy = async () => {
    try {
      // 无分享链接的协议（ssh/wireguard/tailscale）批量复制时排除（避免 per-server 抛错刷屏 toast）
      const selectedServersList = servers.filter(
        (s) => selectedIds.has(s.id) && hasShareLink(s.protocol)
      );
      const urls: string[] = [];
      let successCount = 0;

      for (const server of selectedServersList) {
        const response = await generateShareUrl(server);
        if (response.success && response.data) {
          urls.push(response.data);
          successCount++;
        }
      }

      if (urls.length > 0) {
        await navigator.clipboard.writeText(urls.join('\n'));
        toast.success(t('servers.batchCopySuccess', { count: successCount }));
      } else {
        toast.error(t('servers.shareUrlFail'));
      }
    } catch (error) {
      toast.error(
        t('servers.batchCopyFail', {
          error: error instanceof Error ? error.message : String(error),
        })
      );
    } finally {
      setIsSelecting(false);
      setSelectedIds(new Set());
    }
  };

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const s = new Set(prev);
      if (s.has(id)) {
        s.delete(id);
      } else {
        s.add(id);
      }
      return s;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredServers.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredServers.map((s) => s.id)));
    }
  };

  // 过滤 + 排序
  // 协议筛选项按【当前分组实际存在的协议】动态生成：订阅组不再列 WG/WARP/Tailscale 等不可能出现的协议，
  // 自建/组网组也各只列自己有的——降低无意义选项的理解成本。顺序经 getSortedProtocolOptions 按显示名 locale 排序、custom 置末。
  const availableProtocols = useMemo(() => {
    const present = new Set(servers.map((s) => s.protocol?.toLowerCase()));
    return getSortedProtocolOptions(t, i18n.language, (v) => present.has(v));
  }, [servers, t, i18n.language]);

  // 当前筛选的协议在本组已不存在（切组/订阅更新后）→ 回落 all，避免筛出空列表。
  useEffect(() => {
    if (filterProtocol !== 'all' && !availableProtocols.some((p) => p.value === filterProtocol)) {
      setFilterProtocol('all');
    }
  }, [availableProtocols, filterProtocol]);

  const filteredServers = useMemo(() => {
    let list = servers;

    // 搜索
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.address || '').toLowerCase().includes(q) ||
          s.protocol.toLowerCase().includes(q)
      );
    }

    // 协议过滤
    if (filterProtocol !== 'all') {
      list = list.filter((s) => s.protocol.toLowerCase() === filterProtocol);
    }

    // 排序
    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') {
        cmp = a.name.localeCompare(b.name);
      } else if (sortKey === 'protocol') {
        cmp = a.protocol.localeCompare(b.protocol);
      } else if (sortKey === 'address') {
        cmp = (a.address || '').localeCompare(b.address || '');
      } else if (sortKey === 'latency') {
        const getVal = (v: number | undefined) =>
          v === undefined ? Infinity : v === -1 ? Infinity - 1 : v;
        const la = getVal(latencyMap[a.id]);
        const lb = getVal(latencyMap[b.id]);
        cmp = la - lb;
      }
      return sortOrder === 'asc' ? cmp : -cmp;
    });

    return list;
  }, [servers, searchQuery, filterProtocol, sortKey, sortOrder, latencyMap]);

  const getProtocolBadgeVariant = (protocol: string) => {
    const colors: Record<string, string> = {
      vless: 'bg-badge-blue/15 text-badge-blue border-badge-blue/30',
      trojan: 'bg-badge-purple/15 text-badge-purple border-badge-purple/30',
      hysteria2: 'bg-badge-orange/15 text-badge-orange border-badge-orange/30',
      shadowsocks: 'bg-badge-green/15 text-badge-green border-badge-green/30',
      anytls: 'bg-badge-teal/15 text-badge-teal border-badge-teal/30',
      tuic: 'bg-badge-indigo/15 text-badge-indigo border-badge-indigo/30',
      naive: 'bg-badge-rose/15 text-badge-rose border-badge-rose/30',
      socks: 'bg-badge-slate/15 text-badge-slate border-badge-slate/30',
      http: 'bg-badge-sky/15 text-badge-sky border-badge-sky/30',
      ssh: 'bg-badge-amber/15 text-badge-amber border-badge-amber/30',
      wireguard: 'bg-badge-cyan/15 text-badge-cyan border-badge-cyan/30',
      tailscale: 'bg-badge-blue/15 text-badge-blue border-badge-blue/30',
      custom: 'bg-badge-slate/15 text-badge-slate border-badge-slate/30',
    };
    return colors[protocol.toLowerCase()] || 'bg-muted text-muted-foreground';
  };

  // 操作按钮（卡片和列表模式共用）
  const renderActions = (server: ServerConfigWithId, stopPropagation = true) => (
    <div className="flex items-center gap-1 flex-shrink-0">
      <Button
        variant="ghost"
        size="sm"
        title={t('servers.speedTest')}
        className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
        disabled={testingServerIds.has(server.id) || isTestingSpeed}
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          handleSingleSpeedTest(server.id, e);
        }}
      >
        <Zap
          className={`h-3.5 w-3.5 ${testingServerIds.has(server.id) ? 'animate-pulse text-primary fill-primary/20' : ''}`}
        />
      </Button>

      {latencyMap[server.id] !== undefined && (
        <span
          className={`text-xs font-medium mr-1 px-1.5 py-0.5 rounded ${getLatencyColor(latencyMap[server.id])} ${getLatencyBg(latencyMap[server.id])}`}
        >
          {latencyMap[server.id] === -1 ? t('servers.timeout') : `${latencyMap[server.id]} ms`}
        </span>
      )}
      {/* 无分享链接的协议(ProtocolParser.generateUrl 无对应分支)隐藏复制按钮 */}
      {hasShareLink(server.protocol) && (
        <Button
          variant="ghost"
          size="sm"
          title={t('servers.copyShareUrl')}
          className="h-7 w-7 p-0"
          onClick={(e) => handleCopyShareUrl(server, e)}
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
      )}
      {onCloneServer && (
        <Button
          variant="ghost"
          size="sm"
          title={t('servers.cloneToManual', 'Clone to Manual Nodes')}
          className="h-7 w-7 p-0"
          onClick={(e) => {
            if (stopPropagation) e.stopPropagation();
            onCloneServer(server);
          }}
        >
          <CopyPlus className="h-3.5 w-3.5" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        title={t('common.edit')}
        className="h-7 w-7 p-0"
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          onEditServer(server);
        }}
      >
        <Edit className="h-3.5 w-3.5" />
      </Button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            disabled={!!server.subscriptionId}
            onClick={(e) => {
              if (stopPropagation) e.stopPropagation();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('servers.deleteServerTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('servers.deleteServerDesc', { name: server.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={(e) => e.stopPropagation()}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.stopPropagation();
                handleDelete(server.id);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );

  const deletableSelected = Array.from(selectedIds).filter(
    (id) => !servers.find((s) => s.id === id)?.subscriptionId
  );

  return (
    <div className="space-y-4">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">{t('servers.serverList')}</h3>
          <p className="text-sm text-muted-foreground">{t('servers.serverListDesc')}</p>
        </div>
        <div className="flex gap-2 items-center">
          {/* 视图切换 */}
          <div className="flex rounded-md border overflow-hidden">
            <Button
              variant={viewMode === 'card' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-8 w-8 p-0 rounded-none border-0"
              title={t('servers.viewCard')}
              onClick={() => setViewMode('card')}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === 'list' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-8 w-8 p-0 rounded-none border-0 border-l"
              title={t('servers.viewList')}
              onClick={() => setViewMode('list')}
            >
              <List className="h-4 w-4" />
            </Button>
          </div>

          <Button
            variant="outline"
            className="flex items-center gap-2"
            onClick={handleSpeedTest}
            disabled={isTestingSpeed}
          >
            <Zap className={`h-4 w-4 ${isTestingSpeed ? 'animate-pulse fill-current/20' : ''}`} />
            {isTestingSpeed
              ? speedProgress
                ? `${t('servers.speedTesting')} ${speedProgress.tested}/${speedProgress.total}`
                : t('servers.speedTesting')
              : t('servers.speedTest')}
          </Button>

          {/* 批量选择按钮 */}
          {showAddButton && (
            <Button
              variant={isSelecting ? 'secondary' : 'outline'}
              size="sm"
              className="flex items-center gap-1"
              onClick={() => {
                setIsSelecting(!isSelecting);
                setSelectedIds(new Set());
              }}
            >
              <CheckSquare className="h-4 w-4" />
              {isSelecting ? t('common.cancel') : t('servers.multiSelect')}
            </Button>
          )}

          {showAddButton && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="flex items-center gap-2">
                  <Plus className="h-4 w-4" />
                  {t('servers.addServer')}
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onAddServer}>
                  <Plus className="h-4 w-4 mr-2" />
                  {t('servers.manualAdd')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setIsImportDialogOpen(true)}>
                  <Link className="h-4 w-4 mr-2" />
                  {t('servers.importFromUrl')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* 搜索 + 过滤 + 排序栏 */}
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            className="pl-8 h-9"
            placeholder={t('servers.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <Select value={filterProtocol} onValueChange={setFilterProtocol}>
          <SelectTrigger className="w-[130px] h-9">
            <SelectValue placeholder={t('servers.protocol')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('servers.allProtocols')}</SelectItem>
            {availableProtocols.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-9 flex items-center gap-1">
              <ArrowUpDown className="h-3.5 w-3.5" />
              {t('servers.sort')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {(
              [
                ['name', t('servers.sortName')],
                ['protocol', t('servers.sortProtocol')],
                ['latency', t('servers.sortLatency')],
                ['address', t('servers.sortAddress')],
              ] as [SortKey, string][]
            ).map(([key, label]) => (
              <DropdownMenuItem
                key={key}
                onClick={() => {
                  if (sortKey === key) {
                    setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
                  } else {
                    setSortKey(key);
                    setSortOrder('asc');
                  }
                }}
              >
                {label} {sortKey === key ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                setSortKey('name');
                setSortOrder('asc');
              }}
            >
              {t('servers.resetSort')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 批量操作栏 */}
      {isSelecting && (
        <div className="flex items-center justify-between px-3 py-2 rounded-md bg-muted/60 border">
          <div className="flex items-center gap-3">
            <button
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
              onClick={toggleSelectAll}
            >
              {selectedIds.size === filteredServers.length && filteredServers.length > 0 ? (
                <CheckSquare className="h-4 w-4" />
              ) : (
                <Square className="h-4 w-4" />
              )}
              {t('servers.selectAll')}
            </button>
            <span className="text-sm text-muted-foreground">
              {t('servers.selectedCount', {
                count: selectedIds.size,
                total: filteredServers.length,
              })}
            </span>
          </div>
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="flex items-center gap-1"
                onClick={handleBatchCopy}
              >
                <Copy className="h-3.5 w-3.5" />
                {t('servers.batchCopyCount', { count: selectedIds.size })}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="flex items-center gap-1"
                    disabled={deletableSelected.length === 0}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('servers.deleteCount', { count: deletableSelected.length })}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('servers.batchDelete')}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('servers.batchDeleteDesc', { count: deletableSelected.length })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleBatchDelete}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {t('servers.confirmDelete')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </div>
      )}

      {/* 节点列表 */}
      {filteredServers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Server className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">
              {servers.length === 0
                ? showAddButton
                  ? t('servers.noServers')
                  : t('servers.noNodes')
                : t('servers.noMatchingNodes')}
            </h3>
            <p className="text-sm text-muted-foreground mb-4 text-center">
              {servers.length === 0
                ? showAddButton
                  ? t('servers.noServersDesc')
                  : t('servers.noSubNodesDesc')
                : t('servers.noMatchingDesc')}
            </p>
            {servers.length === 0 && showAddButton && (
              <div className="flex gap-2">
                <Button onClick={onAddServer} className="flex items-center gap-2">
                  <Plus className="h-4 w-4" />
                  {t('servers.manualAdd')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setIsImportDialogOpen(true)}
                  className="flex items-center gap-2"
                >
                  <Link className="h-4 w-4" />
                  {t('servers.importFromUrl')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : viewMode === 'card' ? (
        /* ========= 卡片视图 ========= */
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filteredServers.map((server) => {
            const countryCode = getCountryCode(server.name);
            return (
              <Card
                key={server.id}
                className={`cursor-pointer transition-colors relative overflow-hidden ${
                  selectedServerId === server.id
                    ? 'ring-2 ring-primary bg-primary/5'
                    : 'hover:bg-muted/50'
                } ${isSelecting && selectedIds.has(server.id) ? 'ring-2 ring-primary bg-primary/10' : ''}`}
                onClick={() =>
                  isSelecting
                    ? toggleSelect(server.id, { stopPropagation: () => {} } as any)
                    : onSelectServer(server.id)
                }
              >
                {countryCode && (
                  <div
                    className="absolute -right-4 -bottom-4 z-0 h-28 w-28 opacity-[0.08] select-none pointer-events-none rounded-full overflow-hidden dark:opacity-[0.15]"
                    style={{
                      backgroundImage: `url('https://flagcdn.com/w160/${countryCode}.png')`,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                      backgroundRepeat: 'no-repeat',
                      maskImage:
                        'radial-gradient(circle at 60% 60%, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 85%)',
                      WebkitMaskImage:
                        'radial-gradient(circle at 60% 60%, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 85%)',
                    }}
                  />
                )}
                {/* 批量选择 checkbox */}
                {isSelecting && (
                  <div className="absolute top-2 left-2 z-10 pointer-events-none">
                    <Checkbox checked={selectedIds.has(server.id)} />
                  </div>
                )}
                <CardHeader className={`pb-2 ${isSelecting ? 'pl-8' : ''}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle
                        className={`text-sm truncate ${invalidNodes[server.id] ? 'opacity-50' : ''}`}
                        title={
                          invalidNodes[server.id]
                            ? `${t('servers.nodeInvalid')}: ${invalidNodes[server.id].reason}`
                            : undefined
                        }
                      >
                        {server.name}
                      </CardTitle>
                      <CardDescription className="text-xs mt-0.5">
                        {endpointLabel(server)}
                      </CardDescription>
                    </div>
                    {!isSelecting && renderActions(server)}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    <Badge
                      variant="outline"
                      className={`text-xs h-4 px-1 border ${getProtocolBadgeVariant(server.protocol)}`}
                    >
                      {server.protocol.toUpperCase()}
                    </Badge>
                    {isWarpNode(server) && (
                      <Badge
                        variant="outline"
                        className="text-xs h-4 px-1 bg-badge-sky/15 text-badge-sky border-badge-sky/30"
                      >
                        WARP
                      </Badge>
                    )}
                    {tailscaleNeedsLogin(server) && (
                      <Badge
                        variant="outline"
                        className="text-xs h-4 px-1 bg-badge-amber/15 text-badge-amber border-badge-amber/30"
                      >
                        {t('servers.tsNeedsLogin', 'Login needed')}
                      </Badge>
                    )}
                    {meshInternetOff(server) && (
                      <Badge
                        variant="outline"
                        className="text-xs h-4 px-1 bg-badge-amber/15 text-badge-amber border-badge-amber/30"
                      >
                        {t('servers.noInternetBadge', 'LAN only')}
                      </Badge>
                    )}
                    {selectedServerId === server.id && (
                      <Badge variant="outline" className="text-xs h-4 px-1">
                        {t('servers.current')}
                      </Badge>
                    )}
                    {server.shadowTlsSettings && (
                      <Badge
                        variant="outline"
                        className="text-xs h-4 px-1 text-badge-teal border-badge-teal/50"
                      >
                        +ST
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="pt-0 pb-3">
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {server.protocol?.toLowerCase() === 'shadowsocks' ? (
                      <span>
                        {t('servers.encryption')}: {server.shadowsocksSettings?.method || 'N/A'}
                      </span>
                    ) : (
                      <>
                        <span>
                          {t('servers.transport')}: {getTransportLabel(server)}
                        </span>
                        <span>
                          {t('servers.encryption')}: {server.security || 'none'}
                        </span>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        /* ========= 列表视图 ========= */
        <div className="rounded-md border divide-y">
          {filteredServers.map((server) => {
            const countryCode = getCountryCode(server.name);
            return (
              <div
                key={server.id}
                className={`relative overflow-hidden flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${
                  selectedServerId === server.id ? 'bg-primary/5' : 'hover:bg-muted/50'
                } ${isSelecting && selectedIds.has(server.id) ? 'bg-primary/10' : ''}`}
                onClick={() => {
                  if (isSelecting) {
                    setSelectedIds((prev) => {
                      const s = new Set(prev);
                      if (s.has(server.id)) {
                        s.delete(server.id);
                      } else {
                        s.add(server.id);
                      }
                      return s;
                    });
                  } else {
                    onSelectServer(server.id);
                  }
                }}
              >
                {/* 批量选择 */}
                {isSelecting && (
                  <Checkbox className="pointer-events-none" checked={selectedIds.has(server.id)} />
                )}

                {/* 选中指示器 */}
                {!isSelecting && (
                  <div
                    className={`relative z-10 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      selectedServerId === server.id ? 'bg-primary' : 'bg-transparent'
                    }`}
                  />
                )}

                {/* 背景国旗 */}
                {countryCode && (
                  <div
                    className="absolute right-12 top-1/2 -translate-y-1/2 z-0 h-24 w-24 opacity-[0.05] select-none pointer-events-none rounded-full overflow-hidden dark:opacity-[0.1]"
                    style={{
                      backgroundImage: `url('https://flagcdn.com/w80/${countryCode}.png')`,
                      backgroundSize: 'contain',
                      backgroundPosition: 'center',
                      backgroundRepeat: 'no-repeat',
                      maskImage:
                        'linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,1) 30%, rgba(0,0,0,1) 70%, rgba(0,0,0,0) 100%)',
                      WebkitMaskImage:
                        'linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,1) 30%, rgba(0,0,0,1) 70%, rgba(0,0,0,0) 100%)',
                    }}
                  />
                )}

                {/* 名称 + 地址 */}
                <div className="flex-1 min-w-0 relative z-10">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-sm font-medium truncate ${invalidNodes[server.id] ? 'opacity-50' : ''}`}
                      title={
                        invalidNodes[server.id]
                          ? `${t('servers.nodeInvalid')}: ${invalidNodes[server.id].reason}`
                          : undefined
                      }
                    >
                      {server.name}
                    </span>
                    <Badge
                      variant="outline"
                      className={`text-[10px] h-4 px-1 flex-shrink-0 border ${getProtocolBadgeVariant(server.protocol)}`}
                    >
                      {server.protocol.toUpperCase()}
                    </Badge>
                    {isWarpNode(server) && (
                      <Badge
                        variant="outline"
                        className="text-[10px] h-4 px-1 flex-shrink-0 bg-badge-sky/15 text-badge-sky border-badge-sky/30"
                      >
                        WARP
                      </Badge>
                    )}
                    {tailscaleNeedsLogin(server) && (
                      <Badge
                        variant="outline"
                        className="text-[10px] h-4 px-1 flex-shrink-0 bg-badge-amber/15 text-badge-amber border-badge-amber/30"
                      >
                        {t('servers.tsNeedsLogin', 'Login needed')}
                      </Badge>
                    )}
                    {meshInternetOff(server) && (
                      <Badge
                        variant="outline"
                        className="text-[10px] h-4 px-1 flex-shrink-0 bg-badge-amber/15 text-badge-amber border-badge-amber/30"
                      >
                        {t('servers.noInternetBadge', 'LAN only')}
                      </Badge>
                    )}
                    {server.shadowTlsSettings && (
                      <Badge
                        variant="outline"
                        className="text-[10px] h-4 px-1 flex-shrink-0 text-badge-teal border-badge-teal/50"
                      >
                        +ST
                      </Badge>
                    )}
                    {selectedServerId === server.id && (
                      <Badge variant="outline" className="text-[10px] h-4 px-1 flex-shrink-0">
                        {t('servers.current')}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {endpointLabel(server)}
                    {!isAccountBasedProtocol(server.protocol) &&
                      server.protocol?.toLowerCase() !== 'custom' &&
                      getTransportLabel(server) !== 'tcp' && (
                        <span className="ml-2">{getTransportLabel(server)}</span>
                      )}
                  </p>
                </div>

                {/* 延迟 + 操作 */}
                {!isSelecting && (
                  <div className="relative z-10 flex items-center">{renderActions(server)}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ImportUrlDialog
        open={isImportDialogOpen}
        onOpenChange={setIsImportDialogOpen}
        onImportSuccess={onImportSuccess}
      />
    </div>
  );
}
