/**
 * React hook for listening to IPC events from Electron main process
 */

import { useEffect } from 'react';
import { api } from '../ipc';
import { useAppStore } from '../store/app-store';
import { useTailscaleLoginCacheStore } from '../store/use-tailscale-login-cache-store';
import { ErrorHandler, ErrorCategory, proxyErrorCategory } from '../lib/error-handler';
import { toast } from 'sonner';
import i18n from '../i18n';
import { openExternal } from '../bridge/api-wrapper';
import { safeHttpUrl } from '../../shared/url';
import type {
  TrafficStats,
  IpInfoSnapshot,
  ProxyErrorCode,
  InvalidNodeInfo,
} from '../../shared/types';
import type { TailscaleStatusEvent } from '../../shared/tailscale-status';

// 定义事件数据类型
interface NativeEventData {
  processStarted: { pid: number | null; startTime?: string | Date; autoRestarted?: boolean };
  processStopped: Record<string, never>;
  // 主进程各 emit 点 payload 不完全一致（{message,code}|{message,error}|{message,code,signal}），
  // 统一按 message 优先、error 兜底消费
  processError: {
    message?: string;
    error?: string;
    errorCode?: ProxyErrorCode;
    code?: number;
    signal?: string | null;
  };
  configChanged: { key?: string; oldValue?: any; newValue?: any };
  statsUpdated: TrafficStats;
  ipInfoUpdated: IpInfoSnapshot;
  navigateToPage: string;
  proxyModeSwitched: { success: boolean; newMode: string };
  proxyModeSwitchFailed: { success: boolean; error: string };
  autoNodeSwitched: { reason: string; newServerName: string; latency: number };
  invalidNodes: InvalidNodeInfo[];
  // 1.14 always-emit：所有未登录 TS 节点（含非出口）都会 emit AUTH_URL；payload {nodeName,url,serverId}。
  // authURL 为主核字段别名（瞬态核用 url），消费时 authURL ?? url 兜底取值。
  tailscaleAuth: {
    nodeName: string;
    url: string;
    authURL?: string;
    transient?: boolean;
    serverId?: string;
  };
  // sing-box 1.14 管理 API 推送的 Tailscale 节点真实态（取代 1.13 的 state 目录/stdout 启发式）。
  // = 共享 TailscaleStatusEvent（含 self IP / peers / exitNode，L2/L3）；单一真值防 duck-typing 漂移。
  tailscaleStatus: TailscaleStatusEvent;
  // 启动前属主归一删掉某节点 root 残留 state（登录态失效）→ 渲染端清缓存 + 登录态（review #4）。
  tailscaleStateCleared: { serverId: string };
  systemProxyResidual: { proxy: string };
  speedTestResult: { serverId: string; latency: number };
  // #40 核覆盖 reconcile：本机在用的非官方核 ≤ 随包基线 → 兼容风险提醒（启动时主进程 emit）。
  coreBaselineWarning: { current: string; bundled: string; kind: string };
  // 提权 helper proto < 期望（如属主根治 v6）：启动后主进程 emit → toast 引导升级（带「升级」action + 「不再提示」）。
  helperUpgradeable: { version: string };
}

type NativeEventListener<K extends keyof NativeEventData> = (data: NativeEventData[K]) => void;

export function useNativeEvent<K extends keyof NativeEventData>(
  eventName: K,
  callback: NativeEventListener<K>
) {
  useEffect(() => {
    // 根据事件名称注册对应的监听器
    let unsubscribe: (() => void) | undefined;

    switch (eventName) {
      case 'processStarted':
        unsubscribe = api.proxy.onStarted(callback as any);
        break;
      case 'processStopped':
        unsubscribe = api.proxy.onStopped(callback as any);
        break;
      case 'processError':
        unsubscribe = api.proxy.onError(callback as any);
        break;
      case 'configChanged':
        unsubscribe = api.config.onChanged(callback as any);
        break;
      case 'statsUpdated':
        unsubscribe = api.stats.onUpdated(callback as any);
        break;
      case 'ipInfoUpdated':
        unsubscribe = api.ipInfo.onUpdated(callback as any);
        break;
      case 'autoNodeSwitched':
        unsubscribe = api.proxy.onAutoNodeSwitched(callback as any);
        break;
      case 'invalidNodes':
        unsubscribe = api.proxy.onInvalidNodes(callback as any);
        break;
      case 'tailscaleAuth':
        unsubscribe = api.proxy.onTailscaleAuth(callback as any);
        break;
      case 'tailscaleStatus':
        unsubscribe = api.proxy.onTailscaleStatus(callback as any);
        break;
      case 'tailscaleStateCleared':
        unsubscribe = api.proxy.onTailscaleStateCleared(callback as any);
        break;
      case 'systemProxyResidual':
        unsubscribe = api.proxy.onSystemProxyResidual(callback as any);
        break;
      case 'speedTestResult':
        unsubscribe = api.server.onSpeedTestResult(callback as any);
        break;
      case 'coreBaselineWarning':
        unsubscribe = api.proxy.onCoreBaselineWarning(callback as any);
        break;
      case 'helperUpgradeable':
        unsubscribe = api.helper.onUpgradeable(callback as any);
        break;
      default:
        console.warn(`Unknown event: ${eventName}`);
    }

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [eventName, callback]);
}

// ── 模块级事件处理器 ───────────────────────────────────────────────
// 提到模块层 → 引用稳定，useNativeEvent 的 [eventName, callback] 依赖不再随每次渲染变化，
// 10 个 IPC 监听仅在挂载时订阅一次，避免 App 每次重渲染都退订/重订（抖动 + 潜在监听泄漏）。
// 处理器直接引用静态导入的 useAppStore（无循环依赖），去掉原先逐次 import('../store/app-store')。

function handleProcessStarted(_data: NativeEventData['processStarted']) {
  // Refresh connection status when process starts
  useAppStore.getState().refreshConnectionStatus();
}

function handleProcessStopped(_data: NativeEventData['processStopped']) {
  // Refresh connection status when process stops
  useAppStore.getState().refreshConnectionStatus();
}

function handleProcessError(data: NativeEventData['processError']) {
  console.error('Process error:', data);

  // 各 emit 点 message/error 不一致 → 统一取值，避免「崩溃达上限」等场景因只读 data.error 而漏弹 toast
  const errText = data.message ?? data.error;
  // Display user-friendly error notification
  if (errText) {
    // F15：优先按主进程附带的结构化 errorCode 分类；无码（旧主进程/未覆盖路径）才回落到中文字符串匹配。
    let category = proxyErrorCategory(data.errorCode);
    if (category === null) {
      category = ErrorCategory.Process;
      // Check for Trojan-specific errors
      if (errText.includes('Trojan') || errText.includes('trojan')) {
        category = ErrorCategory.Connection;
      }
      // Check for VLESS-specific errors
      if (errText.includes('VLESS') || errText.includes('vless')) {
        category = ErrorCategory.Connection;
      }
      // Check for protocol errors
      if (errText.includes('不支持的协议') || errText.includes('Protocol')) {
        category = ErrorCategory.Config;
      }
    }

    // Handle the error with appropriate category
    ErrorHandler.handle({
      category,
      userMessage: errText,
      technicalMessage: errText,
    });
  }
}

function handleConfigChanged(data: NativeEventData['configChanged']) {
  // 当收到配置变更事件时，直接使用事件中的新配置更新 store（即使外部并发改动也能即时同步）
  if (data.newValue) {
    useAppStore.setState({ config: data.newValue });
  } else {
    // 如果没有新配置数据，则重新加载；loadConfig 自带单飞，无需再用全局 isLoading 守卫
    useAppStore.getState().loadConfig();
  }
}

function handleStatsUpdated(data: NativeEventData['statsUpdated']) {
  // 事件 payload 即最新 TrafficStats，直接写 store（省去 refreshStatistics 的二次 IPC 拉取）
  useAppStore.setState({ stats: data });
}

function handleIpInfoUpdated(data: NativeEventData['ipInfoUpdated']) {
  // 事件 payload 即最新出口 IP 快照，直接写 store
  useAppStore.setState({ ipInfo: data });
}

function handleAutoNodeSwitched(data: NativeEventData['autoNodeSwitched']) {
  // 刷新连接状态和配置，以反映新节点
  useAppStore.getState().refreshConnectionStatus();
  useAppStore.getState().loadConfig();
  // 显示 toast 通知
  toast.success(i18n.t('home.autoSwitched', { name: data.newServerName, latency: data.latency }), {
    description: i18n.t('home.autoSwitchedDesc'),
    duration: 5000,
  });
}

function handleInvalidNodes(data: NativeEventData['invalidNodes']) {
  // 事件 payload 即本次启动 gate 剔除的全部非法节点（空数组=无/清陈旧）；整体覆盖 store map。
  const map: Record<string, InvalidNodeInfo> = {};
  for (const n of data || []) map[n.id] = n;
  useAppStore.setState({ invalidNodes: map });
}

/**
 * 登录 toast 固定 id：登录成功事件据此 toast.dismiss 那条 Infinity toast。
 * key 优先用 serverId（NIT③：同 hostname 不同 serverId 的两个 Tailscale 节点 nodeName 相同，按 nodeName 作 id
 * 会互相覆盖 toast、AUTH_OK 也会 dismiss 错条目）；serverId 缺失（旧主进程/节点已删）→ 回落 nodeName（与今日一致）。
 */
const tsAuthToastId = (key: string): string => `ts-auth-${key}`;

/** 「打开登录页」action（safeHttpUrl 限定 http(s) 杜绝 file:///javascript: 等危险 scheme + openExternal）。url 非法/缺失 → undefined。 */
function tsLoginAction(url: string | undefined) {
  const safeUrl = url ? safeHttpUrl(url) : undefined;
  return safeUrl
    ? {
        label: i18n.t('servers.tsOpenLogin'),
        onClick: () => {
          void openExternal(safeUrl);
        },
      }
    : undefined;
}

/** 一条「需交互登录」Infinity toast（固定 id 便于登录成功后 dismiss/覆盖）。瞬态核 AUTH_URL 与主核 api STATUS
 *  NeedsLogin 共用此构造，避免文案 / dismiss 规则两处漂移。 */
function showTsLoginToast(idKey: string, name: string, url: string | undefined): void {
  toast.info(i18n.t('servers.tsLoginNeeded', { name }), {
    id: tsAuthToastId(idKey),
    description: i18n.t('servers.tsLoginNeededDesc'),
    duration: Infinity,
    action: tsLoginAction(url),
  });
}

function handleTailscaleAuth(data: NativeEventData['tailscaleAuth']) {
  // 瞬态登录核（非主核 endpoint）给出交互登录 URL → 登录 toast。过期/失效启发式已剥离：登录态（含过期 →
  // loggedIn=false）一律由 api STATUS（tailscaleStatus）驱动，此处不再据 AUTH_URL 反推 loggedIn=false。
  const idKey = data.serverId ?? data.nodeName;
  const url = data.authURL ?? data.url;
  // 空 URL = 登录超时/失败信号（main 侧 armLoginTimeout 发）→ 清缓存退出「登录中」回「需登录」，不弹 toast。
  if (data.serverId && !url) {
    useAppStore.getState().setTailscaleAuthUrl(data.serverId, '');
    return;
  }
  // always-emit：无条件全量入表（transient 与主核两路径都存）→ 角标据此可点直开。serverId 缺失（旧主进程/
  // 节点已删）则无法入表（角标按 serverId 取 URL），跳过存储但 toast 仍按下方门控走。
  if (data.serverId && url) {
    useAppStore.getState().setTailscaleAuthUrl(data.serverId, url);
  }
  // always-emit 后所有未登录节点（含非出口）都会 emit → 仅「当前出口/选中节点」自动弹登录 toast，
  // 其余节点只靠可点角标提示，避免多节点 toast 刷屏。选中信号 = config.selectedServerId（与列表「当前」徽标同源）。
  const selectedServerId = useAppStore.getState().config?.selectedServerId;
  const isSelected = !!data.serverId && data.serverId === selectedServerId;
  if (!isSelected) return;
  if (data.transient) {
    // transient（Phase 2 按需登录核）：主进程已自动开浏览器 + 发系统通知 → 短时长可关闭 toast（非 Infinity）。
    toast.info(i18n.t('servers.tsLoginOpening', { name: data.nodeName }), {
      id: tsAuthToastId(idKey),
      description: i18n.t('servers.tsLoginOpeningDesc'),
      duration: 12000,
      action: tsLoginAction(url),
    });
    return;
  }
  // 非 transient（Phase 1 主核路径）：duration:Infinity——登录需用户去浏览器操作、未自动开，不能自动消失。
  showTsLoginToast(idKey, data.nodeName, url);
}

function handleTailscaleStatus(data: NativeEventData['tailscaleStatus']) {
  // sing-box 1.14 管理 API 真实态（取代 1.13 stateExists/stdout 启发式）：loggedIn（Running||Starting）即时驱动
  // 「需登录」角标；tailscaleIPs（self.tailscaleIPs）入 store 供节点卡「组网信息」popover 展示内网 IP。
  // backendState/authURL 仅本地驱动登录 toast（不入 store）。
  useAppStore.getState().setTailscaleLoginState(data.serverId, data.loggedIn);
  // 内网 IP（self.tailscaleIPs）入 store，组网卡 popover 据此显示。
  useAppStore.getState().setTailscaleIps(data.serverId, data.tailscaleIPs || []);
  // L4：对端列表入 store，供出口节点下拉 + 组网信息 popover（peers 已排除 self，由 userGroups 摊平）。
  useAppStore.getState().setTailscalePeers(data.serverId, data.peers || []);
  // NeedsLogin 且核给出 authURL → 登录 toast（与瞬态核 AUTH_URL 共用 showTsLoginToast，固定 id 供翻 Running 时
  // dismiss/覆盖）。authURL 缺失则不弹（避免空 action）。
  if (data.backendState === 'NeedsLogin' && data.authURL) {
    const server = useAppStore.getState().config?.servers.find((s) => s.id === data.serverId);
    showTsLoginToast(data.serverId, server?.name ?? data.serverId, data.authURL);
  } else {
    // 已认证/离开 NeedsLogin → dismiss 该节点那条登录 toast（固定 id）。
    toast.dismiss(tsAuthToastId(data.serverId));
  }
}

// 启动前属主归一删掉某节点 root 残留 state（登录态已失效）→ 清登录缓存 + 登录态，避免陈旧 loggedIn=true
// 与已清空 state 撕裂（review #4）。代理开启后真实 STATUS 流仍会再校正。
function handleTailscaleStateCleared(data: NativeEventData['tailscaleStateCleared']) {
  useTailscaleLoginCacheStore.getState().removeCached(data.serverId);
  useAppStore.getState().setTailscaleLoginState(data.serverId, false);
}

// 一次性：本渲染会话只提示一次残留系统代理，避免每次连 TUN（含切节点重启）反复唠叨（用户「忽略」即不再提示）。
let residualAdvisedThisSession = false;

function handleSystemProxyResidual(data: NativeEventData['systemProxyResidual']) {
  // TUN 进入后检测到非 FlowZ 设置的系统代理仍开着（无 marker 残留：别的代理软件/外部/企业代理）。
  // 不替用户擅自清（可能是有意的）→ 一次性可关闭提示 + 「关闭系统代理」一键动作（用户显式确认才动手）。
  if (residualAdvisedThisSession) return;
  residualAdvisedThisSession = true;
  const proxy = data.proxy || '';
  toast.warning(i18n.t('proxy.systemProxyResidualTitle'), {
    description: i18n.t('proxy.systemProxyResidualDesc', { proxy: proxy || '—' }),
    duration: 12000,
    action: {
      label: i18n.t('proxy.disableSystemProxy'),
      onClick: () => {
        api.proxy
          .disableSystemProxy()
          .then(() => toast.success(i18n.t('proxy.systemProxyDisabled')))
          .catch(() => toast.error(i18n.t('proxy.systemProxyDisableFailed')));
      },
    },
  });
}

function handleSpeedTestResult(data: NativeEventData['speedTestResult']) {
  // 全局持久监听 per-node 测速结果 → 全局 latencyMap：托盘/UI 两入口测速都经此写入，服务器列表延迟徽标恒同步。
  // 修：原 per-node 监听写在 use-speed-test 的 handler 作用域内（仅 UI 测速期间临时订阅），托盘测速结果无人接、
  // 切走服务器页期间的流式结果也丢失。提到此顶层持久 hook 后两入口统一捕获、跨页不丢。
  useAppStore.getState().applyLatencyResults({ [data.serverId]: data.latency });
}

// #40：非官方核 ≤ 随包基线 → 兼容风险警告 toast（每会话一次，避免每次启动唠叨；同 systemProxyResidual 模式）。
let coreBaselineWarnedThisSession = false;
function handleCoreBaselineWarning(data: NativeEventData['coreBaselineWarning']) {
  if (coreBaselineWarnedThisSession) return;
  coreBaselineWarnedThisSession = true;
  toast.warning(i18n.t('settings.advanced.coreBaselineWarnTitle'), {
    description: i18n.t('settings.advanced.coreBaselineWarnDesc', {
      current: data.current,
      bundled: data.bundled,
    }),
    duration: 15000,
  });
}

// 提权 helper 可升级（proto < 期望，如属主根治 v6）→ 启动弹窗引导升级。每会话一次；带「升级」action（直接装、一次授权）
// + 「不再提示」（持久化 helperUpgradePromptDismissed，下次启动不再发）。
let helperUpgradeWarnedThisSession = false;
function handleHelperUpgradeable(_data: NativeEventData['helperUpgradeable']) {
  if (helperUpgradeWarnedThisSession) return;
  helperUpgradeWarnedThisSession = true;
  toast.warning(i18n.t('helper.upgrade.title', '提权助手有新版本'), {
    description: i18n.t(
      'helper.upgrade.desc',
      '新版修复了跨提权态的文件属主冲突（会导致 Tailscale / 启动异常）。建议升级，仅需授权一次。'
    ),
    duration: Infinity,
    action: {
      label: i18n.t('helper.upgrade.action', '升级'),
      onClick: () => {
        void api.helper.install();
      },
    },
    cancel: {
      label: i18n.t('helper.upgrade.dismiss', '不再提示'),
      onClick: () => {
        void api.config.setValue('helperUpgradePromptDismissed', true);
      },
    },
  });
}

/**
 * Hook to listen to all native events and update store
 */
export function useNativeEventListeners() {
  useNativeEvent('processStarted', handleProcessStarted);
  useNativeEvent('processStopped', handleProcessStopped);
  useNativeEvent('processError', handleProcessError);
  useNativeEvent('configChanged', handleConfigChanged);
  useNativeEvent('statsUpdated', handleStatsUpdated);
  useNativeEvent('ipInfoUpdated', handleIpInfoUpdated);
  useNativeEvent('autoNodeSwitched', handleAutoNodeSwitched);
  useNativeEvent('invalidNodes', handleInvalidNodes);
  useNativeEvent('tailscaleAuth', handleTailscaleAuth);
  useNativeEvent('tailscaleStatus', handleTailscaleStatus);
  useNativeEvent('tailscaleStateCleared', handleTailscaleStateCleared);
  useNativeEvent('systemProxyResidual', handleSystemProxyResidual);
  useNativeEvent('speedTestResult', handleSpeedTestResult);
  useNativeEvent('coreBaselineWarning', handleCoreBaselineWarning);
  useNativeEvent('helperUpgradeable', handleHelperUpgradeable);

  // L2 治本：挂载即主动拉一次 Tailscale 状态末帧 → 填 store（self IP + peers），不干等下一帧推送。
  // 根治「状态流 push-only-on-change、无心跳、渲染端错过那一帧即永久陈旧」（内网IP「尚未分配」/peers 拿不到）。
  // 只填显示数据(IP/peers)；登录态走自有缓存(tailscaleLoginStates)不在此掺和。connected=false 时 statuses 为
  // 上次已知陈旧值，仍填入——UI 据 connectionStatus.proxyCore.running 决定是否灰显，不在数据层丢可用性。
  useEffect(() => {
    let cancelled = false;
    void api.server
      .tailscaleGetStatus()
      .then((snap) => {
        if (cancelled || !snap?.statuses) return;
        const store = useAppStore.getState();
        for (const st of snap.statuses) {
          store.setTailscaleIps(st.serverId, st.tailscaleIPs || []);
          store.setTailscalePeers(st.serverId, st.peers || []);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
}
