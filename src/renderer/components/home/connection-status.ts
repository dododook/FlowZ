/**
 * 连接状态卡的状态推导 —— 纯函数，从原 connection-status-card.tsx 抽出（该卡已退役，逻辑并入 connection-control-card / home-status-bar；审计 §4）。
 * 输入 store 快照 + i18n 取值器，输出卡片展示信息（label/variant/description）。
 * 无 react/store 依赖、t 由参数注入 → 可被 .test.ts 直接覆盖各状态档位矩阵。
 *
 * §4 修复：删除原对 `proxyCore.error` 的中文 `.includes()`（'权限不足'/'wintun'/'sing-box.exe'…）分类——
 *   该字段经 getStatus()/store 链路恒为 undefined（errorCode 协议 + F2 proxyError 拆分后的死残留），
 *   且错误分类的唯一依据应是 errorCode（已由 error-handler/use-native-events 按码分类，见其 F15）。
 *   本卡片仅「展示」已成串的 proxyError / 原始 error，不再按本地化文案脆弱分类（修「main 改文案→UI 静默失配」）。
 */
import type { UserConfig } from '../../../shared/types';

/** 卡片消费的连接状态视图（store ConnectionStatus 的结构子集；多余字段结构兼容）。 */
export interface ConnectionStatusView {
  proxyCore: { running: boolean; uptime?: number; error?: string };
  proxy: { enabled: boolean };
  proxyModeType: UserConfig['proxyModeType'];
}

export interface StatusInfo {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  description: string;
  isManualNotice?: boolean;
}

export interface DeriveStatusInputs {
  proxyError: string | null;
  connectionStatus: ConnectionStatusView | null;
  configProxyModeType: UserConfig['proxyModeType'] | undefined;
  proxyBusy: boolean;
  proxyPhase: 'idle' | 'starting' | 'stopping';
}

type TFn = (key: string, opts?: Record<string, unknown>) => string;

export function deriveConnectionStatus(inputs: DeriveStatusInputs, t: TFn): StatusInfo {
  const { proxyError, connectionStatus, configProxyModeType, proxyBusy, proxyPhase } = inputs;

  const proxyModeType = configProxyModeType || connectionStatus?.proxyModeType || 'systemProxy';
  const isTunMode = proxyModeType === 'tun';
  const isManualMode = proxyModeType === 'manual';

  // store proxyError（start/stop 写的 i18n / String(error)）优先展示
  if (proxyError) {
    return {
      label: t('home.statusError'),
      variant: 'destructive',
      description: proxyError,
    };
  }

  if (!connectionStatus) {
    return {
      label: t('home.statusUnknown'),
      variant: 'secondary',
      description: t('home.fetchingStatus'),
    };
  }

  const { proxyCore, proxy } = connectionStatus;

  // §4：仅展示原始错误串，不再按本地化文案 .includes() 分类（分类归 errorCode/error-handler）
  if (proxyCore.error) {
    return {
      label: t('home.statusError'),
      variant: 'destructive',
      description: proxyCore.error,
    };
  }

  const uptimeText = proxyCore.uptime
    ? t('home.uptime', { min: Math.floor(proxyCore.uptime / 60) })
    : '';

  // TUN 模式：只看核心是否运行
  if (isTunMode) {
    if (proxyCore.running) {
      return {
        label: t('home.statusConnected'),
        variant: 'default',
        description: `${t('home.tunMode')}${t('home.statusConnected')}${uptimeText ? ' - ' + uptimeText : ''}`,
      };
    }
    if (proxyBusy) {
      const stopping = proxyPhase === 'stopping';
      return {
        label: t(stopping ? 'home.disconnecting' : 'home.statusConnecting'),
        variant: 'secondary',
        description: t(stopping ? 'home.stoppingProxy' : 'home.startingTun'),
      };
    }
    return {
      label: t('home.statusDisconnected'),
      variant: 'outline',
      description: t('home.tunNotEnabled'),
    };
  }

  // 系统代理 / 仅本地代理（manual）：核心运行 + (系统代理已启用 或 manual)
  if (proxyCore.running && (proxy.enabled || isManualMode)) {
    if (isManualMode) {
      return {
        label: t('home.statusConnected'),
        variant: 'default',
        description: uptimeText ? `${t('home.manualMode')} - ${uptimeText}` : t('home.manualMode'),
        isManualNotice: true,
      };
    }
    return {
      label: t('home.statusConnected'),
      variant: 'default',
      description: `${t('home.systemProxyConnected')}${uptimeText ? ' - ' + uptimeText : ''}`,
    };
  }

  // 核心已起但系统代理未启用（非 manual）→ 启用中
  if (proxyCore.running && !proxy.enabled && !isManualMode) {
    return {
      label: t('home.statusConnecting'),
      variant: 'secondary',
      description: t('home.singboxRunningEnabling'),
    };
  }

  if (proxyBusy) {
    const stopping = proxyPhase === 'stopping';
    return {
      label: t(stopping ? 'home.disconnecting' : 'home.statusConnecting'),
      variant: 'secondary',
      description: t(stopping ? 'home.stoppingProxy' : 'home.startingSingbox'),
    };
  }

  return {
    label: t('home.statusDisconnected'),
    variant: 'outline',
    description: t('home.proxyNotEnabled'),
  };
}
