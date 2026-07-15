import {
  Tray,
  Menu,
  nativeImage,
  BrowserWindow,
  app,
  MenuItemConstructorOptions,
  shell,
} from 'electron';
import { LogManager } from './LogManager';
import { releaseWindowMemory } from './window-memory';
import { ServerConfig, ProxyMode, ProxyModeType, SubscriptionConfig } from '../../shared/types';
import { groupServersBySubscription } from '../../shared/server-grouping';
import { sortServersByLatency } from '../../shared/server-latency-sort';
import { mt } from '../i18n';
import { DIRECT_SERVER_ID, isDirectSelection } from '../../shared/direct-selection';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { SpeedTestOutcome } from '../../shared/speed-test';

// 托盘菜单状态圆点（macOS 系统色，18px 抗锯齿）——替代旧的 emoji 大圆圈，更克制现代。
const STATUS_DOT_PNG: Record<'connected' | 'disconnected' | 'error', string> = {
  connected:
    'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAABaklEQVR4nLWUsS9DURTGv3Pf5Un7eKKLRWJjYG3ErIv9LsR/ItGXGPwdGoa+3cIsYrXUJrEYVChafb29n0Ef9dpIVH3juef8zjk551xgTJIfXwkxsVEAEJvYQcDf4QkxVeNlzaZqPHB48kEjIWnmtXMzZ7VeBQBt7dXFevyQ9RkO6jkUT7ZnMC/7ALcAKfQe64Ac4467l5tHjSxMvkHKe7JUus3PTL6d6dAvdh7bQNc5AICn1MSsD/vUvmwkUxvXpwuvKEdMYeqz/9goRJELVPNAh34xuW8l6JIQURBR6JLJfSvRoV8MVPMAUeTSQXxV1Ctz+XSnEEzbG1GSo6VABlqnaCEdmy/PerFWqtTTWPVZDYAgb1eU7+VoHQYgH2mF1kH5Xi7I25X+WDXgPKLG2xoENFXj1UqVOh0Pdegrkh2wb1cIkuzo0Fd0PKyVKnVTNV46tbGN/x8WMgMDfnciwzWWo80C//SNjKB3ueTmNzrOQ7YAAAAASUVORK5CYII=',
  disconnected:
    'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAABmklEQVR4nLWUMW7bQBBF/wwlktgVUkQXyAGcVifIFaTCdxBSqCMMmAQMw42K2EV6Fy6WV8gJ0toHyAU2BSERJG3OpBBpKIxsIII91WL/zNvZnZkF3sjoNVFVKc9zBoD5fC5EpP9FV1VyzgXDfedcoKoHDx8dgnQnt+v1+iMQf94p1f1isfg98DkM6h3Oz799mE7DC4BOiTDdadZfX3+/8745I6JiCKN9SJqmZIyxUTT5Ya2dbTYbqKoAABHxZDLBdrv9WdebL2VZbtM01R7GPSjPc86yTMZjc2WtnRVF0YiIdj4sIloURWOtnY3H5irLMukL8ZxRn+bl5c00jvUX88i07RMR0V8Pq6oaBCMVeSqrij4lydL3sdxnAwBRxCdhGBuRFkNIdz0SaRGGsYkiPtmP5aHzsfbcbABQ1/LQNFXJHEBV/2k+VVXmAE1TlXUtD/ux3KWszrkgSZYeoFtrDQN43Id168edRrdJsvTOuaCv2puVf1iVVxoSHtA775uzLPv6ckMOYQAwHJHVavXiiBy0Y4b2fb+RY+wP33oSwpBBhJQAAAAASUVORK5CYII=',
  error:
    'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAABQklEQVR4nK2UTUoDQRCFv+qZNmMUF+YCLgRF4tLgAfQIvfEsggRc5BxZuMkR9ACSLAWJ4MILxIX4OxPmuZAJOhmFxHnL+nlV1a+qoSbYX06BEYIDYDDIDbQQu8AUQjRnDyHSL8XnjAIrKutwb5N4ZR+AaXpj17eP5ZhKoiJAne0NGuvnyE4wa305NcF0wcfzqQ3vn8pk9p2EM4zLnTVs9QrvO0wzyMkBcDhiD1k2RG9HHN+90EUFmZu1E4KzLjmW9PC+Q5qlCGE4DIcQaZbifQdLetYlnwlRdDQb6WC3hU8eMGuCrOINBSakV7L3LRuNJ0WuK7oBoJG0iVwTqVIIwJAgck0aSft7rqsIXgr1jmYghRDZaDzB1MfHDpHxc1eEyPCxw9S30XiiEKJCtdrkr38hy2Sw2IlUolajLRP+6xtZBp8CmLpNChT41AAAAABJRU5ErkJggg==',
};

/** 托盘菜单协议简写（菜单宽度受限，长协议名缩短以保留延迟显示；其余协议已短，原样大写）。 */
const PROTOCOL_SHORT: Record<string, string> = {
  wireguard: 'WG',
  tailscale: 'TS',
  shadowsocks: 'SS',
  hysteria2: 'Hy2',
};

export type TrayIconState = 'idle' | 'connected' | 'connecting';

export interface TrayMenuData {
  isProxyRunning: boolean;
  hasError?: boolean;
  servers: ServerConfig[];
  subscriptions?: SubscriptionConfig[];
  selectedServerId: string | null;
  proxyMode: ProxyMode;
  proxyModeType: ProxyModeType;
}

export interface ITrayManager {
  createTray(): void;
  destroyTray(): void;
  hasTray(): boolean;
  updateTrayIcon(state: TrayIconState): void;
  updateTrayMenu(isProxyRunning: boolean): void;

  /** 更新完整托盘菜单（包含服务器列表和代理模式）。 */
  updateFullTrayMenu(data: TrayMenuData): void;

  enterLightweightMode(): void;
}

/**
 * 托盘管理器
 * 负责创建和管理系统托盘图标及其上下文菜单
 */
export class TrayManager implements ITrayManager {
  private tray: Tray | null = null;
  private mainWindow: BrowserWindow | null = null;
  private logManager: LogManager;
  private currentState: TrayIconState = 'idle';
  private isProxyRunning: boolean = false;
  private servers: ServerConfig[] = [];
  private subscriptions: SubscriptionConfig[] = [];
  private selectedServerId: string | null = null;
  private proxyMode: ProxyMode = 'smart';
  private proxyModeType: ProxyModeType = 'systemProxy';
  // 语言：托盘文案经 mt() 走主进程 i18n 中央语言持有点（据 config.language 单一真值源，启动 + config-change
  // 由 index.ts 重设并重渲染菜单），故本类不自持语言、也不再暴露 setLanguage。

  // 回调函数
  private onStartProxy?: () => void;
  private onStopProxy?: () => void;
  private onShowWindow?: () => void;
  private onQuit?: () => void;
  private onSelectServer?: (serverId: string) => void;
  private onChangeProxyMode?: (mode: ProxyMode) => void;
  private onChangeProxyModeType?: (modeType: ProxyModeType) => void;
  private onOpenSettings?: () => void;
  private onCheckUpdate?: () => void;
  private onManageServers?: () => void;
  private onSpeedTest?: () => void;
  private onLightweightMode?: () => void;
  private onEnterPrivacyMode?: () => void;

  // 测速结果
  private speedTestResults: Map<string, number | null> = new Map();
  private isSpeedTesting: boolean = false;
  // 节点列表「按延迟排序」开关（默认按名称）：由渲染端经 APP_SET_NODE_SORT_BY_LATENCY 同步，使托盘列表与下拉同序。
  private sortByLatency: boolean = false;

  constructor(
    mainWindow: BrowserWindow | null,
    logManager: LogManager,
    callbacks?: {
      onStartProxy?: () => void;
      onStopProxy?: () => void;
      onShowWindow?: () => void;
      onQuit?: () => void;
      onSelectServer?: (serverId: string) => void;
      onChangeProxyMode?: (mode: ProxyMode) => void;
      onChangeProxyModeType?: (modeType: ProxyModeType) => void;
      onOpenSettings?: () => void;
      onCheckUpdate?: () => void;
      onManageServers?: () => void;
      onSpeedTest?: () => void;
      onLightweightMode?: () => void;
      onEnterPrivacyMode?: () => void;
    }
  ) {
    this.mainWindow = mainWindow;
    this.logManager = logManager;
    this.onStartProxy = callbacks?.onStartProxy;
    this.onStopProxy = callbacks?.onStopProxy;
    this.onShowWindow = callbacks?.onShowWindow;
    this.onQuit = callbacks?.onQuit;
    this.onSelectServer = callbacks?.onSelectServer;
    this.onChangeProxyMode = callbacks?.onChangeProxyMode;
    this.onChangeProxyModeType = callbacks?.onChangeProxyModeType;
    this.onOpenSettings = callbacks?.onOpenSettings;
    this.onCheckUpdate = callbacks?.onCheckUpdate;
    this.onManageServers = callbacks?.onManageServers;
    this.onSpeedTest = callbacks?.onSpeedTest;
    this.onLightweightMode = callbacks?.onLightweightMode;
    this.onEnterPrivacyMode = callbacks?.onEnterPrivacyMode;
  }

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  createTray(): void {
    if (this.tray) {
      this.logManager.addLog('warn', 'Tray already exists', 'TrayManager');
      return;
    }

    try {
      const icon = this.loadTrayIcon('idle');

      this.tray = new Tray(icon);
      this.tray.setToolTip('FlowZ');

      // 托盘点击行为：
      // macOS —— 单击弹出菜单（setContextMenu 原生行为，再点别处自动收回），不直接开主窗口；
      //          主窗口仅经菜单「打开主窗口」打开（符合 macOS 菜单栏惯例）。
      // Win/Linux —— 保留单击打开主窗口（右键弹菜单）。
      if (process.platform !== 'darwin') {
        this.tray.on('click', () => {
          this.handleTrayClick();
        });
      }

      // 创建上下文菜单
      this.updateTrayMenu(false);

      this.logManager.addLog('info', 'Tray icon created', 'TrayManager');
    } catch (error) {
      this.logManager.addLog(
        'error',
        `Failed to create tray icon: ${error instanceof Error ? error.message : String(error)}`,
        'TrayManager'
      );
    }
  }

  destroyTray(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
      this.logManager.addLog('info', 'Tray icon destroyed', 'TrayManager');
    }
  }

  /** 托盘图标是否真实存在（createTray 可能失败被静默吞 → this.tray=null）。供 window-all-closed 判定避免无图标僵尸驻留。 */
  hasTray(): boolean {
    return this.tray !== null;
  }

  updateTrayIcon(state: TrayIconState): void {
    if (!this.tray) {
      this.logManager.addLog('warn', 'Cannot update tray icon: tray not created', 'TrayManager');
      return;
    }

    try {
      this.currentState = state;
      const icon = this.loadTrayIcon(state);

      this.tray.setImage(icon);

      if (state !== 'connected') {
        this.speedTestResults.clear();
      }

      this.updateTrayTooltip();

      // 托盘图标状态刷新较频繁（状态轮询/重启/切节点都会触发），降到 debug 避免刷屏 info 日志。
      this.logManager.addLog('debug', `Tray icon updated to state: ${state}`, 'TrayManager');
    } catch (error) {
      this.logManager.addLog(
        'error',
        `Failed to update tray icon: ${error instanceof Error ? error.message : String(error)}`,
        'TrayManager'
      );
    }
  }

  /**
   * 更新托盘菜单（简化版，保持向后兼容）
   */
  updateTrayMenu(isProxyRunning: boolean): void {
    this.updateFullTrayMenu({
      isProxyRunning,
      servers: this.servers,
      subscriptions: this.subscriptions,
      selectedServerId: this.selectedServerId,
      proxyMode: this.proxyMode,
      proxyModeType: this.proxyModeType,
    });
  }

  updateFullTrayMenu(data: TrayMenuData): void {
    if (!this.tray) {
      this.logManager.addLog('warn', 'Cannot update tray menu: tray not created', 'TrayManager');
      return;
    }

    this.isProxyRunning = data.isProxyRunning;
    this.servers = data.servers;
    this.subscriptions = data.subscriptions || [];
    this.selectedServerId = data.selectedServerId;
    this.proxyMode = data.proxyMode;
    this.proxyModeType = data.proxyModeType;

    let statusLabel: string;
    let statusState: 'connected' | 'disconnected' | 'error';
    if (data.hasError) {
      statusLabel = mt('trayStatusError');
      statusState = 'error';
    } else if (data.isProxyRunning) {
      statusLabel = mt('trayStatusConnected');
      statusState = 'connected';
    } else {
      statusLabel = mt('trayStatusDisconnected');
      statusState = 'disconnected';
    }

    // 构建服务器子菜单（按订阅/自建分组：单组平铺，多组用嵌套子菜单——节点多时更易导航）
    const serverSubmenu: MenuItemConstructorOptions[] = [];
    const maxLabelLength = 30;

    const buildServerItem = (server: ServerConfig): MenuItemConstructorOptions => {
      const name = server.name || server.address;
      const proto =
        PROTOCOL_SHORT[(server.protocol || '').toLowerCase()] ??
        (server.protocol || '').toUpperCase();
      const latency = this.speedTestResults.get(server.id);
      const latencyStr =
        latency !== undefined
          ? latency !== null
            ? ` [${latency}ms]`
            : ` [${mt('trayTimeout')}]`
          : '';
      // 超长只截「名字」，保「（协议）[延迟]」完整——延迟是选节点的关键信息，不应被尾部截断吃掉。
      const suffix = `（${proto}）${latencyStr}`;
      const maxName = Math.max(6, maxLabelLength - suffix.length);
      const shownName = name.length > maxName ? `${name.slice(0, maxName - 1)}…` : name;
      const label = `${shownName}${suffix}`;
      return {
        label,
        type: 'radio' as const,
        checked: server.id === data.selectedServerId,
        click: () => this.handleSelectServer(server.id),
      };
    };

    // 「按延迟排序」开关：开则有效延迟升序在前（超时/未测垫底、无结果按名称降级），关则保留 config 原序——
    // 与下拉同序（共用比较器）。关时不排序而非按名称，避免默认态静默打乱用户的订阅/自建顺序。
    const sortNodes = (arr: ServerConfig[]): ServerConfig[] =>
      this.sortByLatency ? sortServersByLatency(arr, (id) => this.speedTestResults.get(id)) : arr;

    // 「直连」置顶项（全局直连哨兵，#73）：与首页节点选择同概念、同步；选中即 proxy-selector→direct（热切换）。
    serverSubmenu.push({
      label: mt('trayDirect'),
      type: 'radio' as const,
      checked: isDirectSelection(data.selectedServerId),
      click: () => this.handleSelectServer(DIRECT_SERVER_ID),
    });
    serverSubmenu.push({ type: 'separator' });

    if (data.servers.length === 0) {
      serverSubmenu.push({
        label: mt('trayNoServers'),
        enabled: false,
      });
      serverSubmenu.push({ type: 'separator' });
    } else {
      const groups = groupServersBySubscription(data.servers, data.subscriptions);
      if (groups.length <= 1) {
        // 单一来源：平铺
        sortNodes(data.servers).forEach((s) => serverSubmenu.push(buildServerItem(s)));
      } else {
        // 多来源：每个订阅/自建/组网一个子菜单（组内按当前排序策略）
        for (const g of groups) {
          serverSubmenu.push({
            label: g.isMesh ? mt('trayMesh') : g.isManual ? mt('trayCustomNodes') : g.name,
            submenu: sortNodes(g.servers).map(buildServerItem),
          });
        }
      }
      serverSubmenu.push({ type: 'separator' });
    }

    serverSubmenu.push({
      label: mt('trayManageServers'),
      click: () => this.handleManageServers(),
    });

    const proxyModeLabels: Record<ProxyMode, string> = {
      global: mt('trayGlobalProxy'),
      smart: mt('traySmartRouting'),
      direct: mt('trayDirectMode'),
    };

    const proxyModeSubmenu: MenuItemConstructorOptions[] = (
      ['global', 'smart', 'direct'] as ProxyMode[]
    ).map((mode) => ({
      label: proxyModeLabels[mode],
      type: 'radio' as const,
      checked: data.proxyMode === mode,
      click: () => this.handleChangeProxyMode(mode),
    }));

    // 接管方式（systemProxy/tun/manual）子菜单——无需打开主窗口即可切换
    const proxyModeTypeLabels: Record<ProxyModeType, string> = {
      systemProxy: mt('traySystemProxy'),
      tun: mt('trayTun'),
      manual: mt('trayLocalOnly'),
    };
    const proxyModeTypeSubmenu: MenuItemConstructorOptions[] = (
      ['systemProxy', 'tun', 'manual'] as ProxyModeType[]
    ).map((modeType) => ({
      label: proxyModeTypeLabels[modeType],
      type: 'radio' as const,
      checked: data.proxyModeType === modeType,
      click: () => this.handleChangeProxyModeType(modeType),
    }));

    const contextMenu = Menu.buildFromTemplate([
      {
        label: statusLabel,
        icon: this.statusDotIcon(statusState),
        enabled: false,
      },
      { type: 'separator' },
      {
        label: mt('trayOpenMainWindow'),
        click: () => this.handleShowWindow(),
      },
      {
        label: data.isProxyRunning ? mt('trayDisableProxy') : mt('trayEnableProxy'),
        click: () => {
          if (data.isProxyRunning) {
            this.handleStopProxy();
          } else {
            this.handleStartProxy();
          }
        },
      },
      { type: 'separator' },
      {
        label: mt('traySelectServer'),
        submenu: serverSubmenu,
      },
      {
        label: mt('trayTakeover'),
        submenu: proxyModeTypeSubmenu,
      },
      {
        label: mt('trayRouting'),
        submenu: proxyModeSubmenu,
      },
      { type: 'separator' },
      {
        label: mt('trayLightweightMode'),
        click: () => this.handleLightweightMode(),
      },
      {
        label: mt('trayPrivacyMode'),
        click: () => this.handleEnterPrivacyMode(),
      },
      {
        label: mt('trayOpenSettings'),
        click: () => this.handleOpenSettings(),
      },
      {
        label: mt('trayCheckUpdates'),
        click: () => this.handleCheckUpdate(),
      },
      { type: 'separator' },
      {
        label: this.getSpeedTestLabel(),
        enabled: !this.isSpeedTesting,
        click: () => this.handleSpeedTest(),
      },
      { type: 'separator' },
      {
        label: mt('trayQuit'),
        click: () => this.handleQuit(),
      },
    ]);

    this.tray.setContextMenu(contextMenu);
    this.logManager.addLog('debug', 'Tray menu updated', 'TrayManager');
  }

  private loadTrayIcon(state: TrayIconState): Electron.NativeImage {
    const { resourceManager } = require('./ResourceManager');
    const iconPath = resourceManager.getTrayIconPath(state === 'connected');

    const fs = require('fs');
    let icon: Electron.NativeImage;

    if (fs.existsSync(iconPath)) {
      icon = nativeImage.createFromPath(iconPath);
      this.logManager.addLog('debug', `Loaded tray icon from: ${iconPath}`, 'TrayManager');

      // macOS 托盘图标需要调整大小为 22x22（或 16x16）
      // 高 DPI 屏幕会自动使用 @2x 版本
      if (process.platform === 'darwin') {
        icon = icon.resize({ width: 18, height: 18 });
        // 不用模板图：模板图强制单色，会抹掉「已连接(蓝)/未连接(灰)」的颜色区分，菜单栏看起来恒亮。
        // 连接态用彩色 app.png / 灰色 app-gray.png 区分（updateTrayIcon 按状态切换）。
      }
    } else {
      this.logManager.addLog(
        'warn',
        `Tray icon not found: ${iconPath}, using default`,
        'TrayManager'
      );
      icon = this.createDefaultTrayIcon();
    }

    return icon;
  }

  private createDefaultTrayIcon(): Electron.NativeImage {
    const size = 22;
    const canvas = `
      <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${size}" height="${size}" fill="transparent"/>
        <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" 
              font-family="Arial" font-size="16" font-weight="bold" fill="black">V</text>
      </svg>
    `;
    return nativeImage.createFromDataURL(
      `data:image/svg+xml;base64,${Buffer.from(canvas).toString('base64')}`
    );
  }

  private handleTrayClick(): void {
    this.logManager.addLog('info', 'Tray icon clicked', 'TrayManager');
    this.handleShowWindow();
  }

  private handleStartProxy(): void {
    this.logManager.addLog('info', 'Start proxy clicked from tray', 'TrayManager');
    if (this.onStartProxy) {
      this.onStartProxy();
    }
  }

  private handleStopProxy(): void {
    this.logManager.addLog('info', 'Stop proxy clicked from tray', 'TrayManager');
    if (this.onStopProxy) {
      this.onStopProxy();
    }
  }

  private handleLightweightMode(): void {
    this.logManager.addLog('info', 'Enter lightweight mode clicked from tray', 'TrayManager');
    if (this.onLightweightMode) {
      this.onLightweightMode();
    } else if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      // 兜底分支（生产环境恒不可达，onLightweightMode 由 tray-actions.ts 恒注入）：不经
      // index.ts 的 markLightweightModeTransition 标记，minimizeToTray=false 时销毁窗口会
      // 被 window-all-closed 误判成用户关闭而连带退出 app。可接受——真正接线的路径（上面
      // onLightweightMode 分支）已正确处理，这里只是防未接线时至少还能释放内存。
      releaseWindowMemory({
        window: this.mainWindow,
        logManager: this.logManager,
        clearLogsAndGc: true,
        reason: 'lightweight-mode',
      });
    }
  }

  private handleEnterPrivacyMode(): void {
    this.logManager.addLog('info', 'Enter privacy mode clicked from tray', 'TrayManager');
    // onEnterPrivacyMode 由 index.ts 构造 TrayManager 时恒注入（置主进程隐私 flag 并广播）。
    // 此处仅经回调，不再 require('../index') 兜底——那是死分支且会形成 TrayManager→index 循环依赖。
    this.onEnterPrivacyMode?.();
  }

  private handleShowWindow(): void {
    this.logManager.addLog('info', 'Show window clicked from tray', 'TrayManager');
    if (this.onShowWindow) {
      this.onShowWindow();
    } else if (this.mainWindow) {
      if (this.mainWindow.isMinimized()) {
        this.mainWindow.restore();
      }
      this.mainWindow.show();
      this.mainWindow.focus();
    }
  }

  private handleQuit(): void {
    this.logManager.addLog('info', 'Quit clicked from tray', 'TrayManager');
    if (this.onQuit) {
      this.onQuit();
    } else {
      app.quit();
    }
  }

  private handleSelectServer(serverId: string): void {
    this.logManager.addLog('info', `Server selected from tray: ${serverId}`, 'TrayManager');
    if (this.onSelectServer) {
      this.onSelectServer(serverId);
    }
  }

  private handleChangeProxyMode(mode: ProxyMode): void {
    this.logManager.addLog('info', `Proxy mode changed from tray: ${mode}`, 'TrayManager');
    if (this.onChangeProxyMode) {
      this.onChangeProxyMode(mode);
    }
  }

  /** 托盘状态行的小圆点图标（绿/灰/红），替代旧 emoji。 */
  private statusDotIcon(state: 'connected' | 'disconnected' | 'error'): Electron.NativeImage {
    return nativeImage.createFromDataURL(`data:image/png;base64,${STATUS_DOT_PNG[state]}`);
  }

  private handleChangeProxyModeType(modeType: ProxyModeType): void {
    this.logManager.addLog('info', `Takeover mode changed from tray: ${modeType}`, 'TrayManager');
    if (this.onChangeProxyModeType) {
      this.onChangeProxyModeType(modeType);
    }
  }

  private handleOpenSettings(): void {
    this.logManager.addLog('info', 'Open settings clicked from tray', 'TrayManager');
    if (this.onOpenSettings) {
      this.onOpenSettings();
    } else {
      // 默认行为：显示窗口并导航到设置页面
      this.handleShowWindow();
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(IPC_CHANNELS.EVENT_NAVIGATE, '/settings');
      }
    }
  }

  private handleCheckUpdate(): void {
    this.logManager.addLog('info', 'Check update clicked from tray', 'TrayManager');
    if (this.onCheckUpdate) {
      this.onCheckUpdate();
    } else {
      // 默认行为：打开 GitHub releases 页面
      shell.openExternal('https://github.com/dododook/FlowZ/releases');
    }
  }

  private handleManageServers(): void {
    this.logManager.addLog('info', 'Manage servers clicked from tray', 'TrayManager');
    if (this.onManageServers) {
      this.onManageServers();
    } else {
      // 默认行为：显示窗口并导航到服务器页面
      this.handleShowWindow();
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(IPC_CHANNELS.EVENT_NAVIGATE, '/server');
      }
    }
  }

  private handleSpeedTest(): void {
    this.logManager.addLog('info', 'Speed test clicked from tray', 'TrayManager');
    if (this.onSpeedTest) {
      this.isSpeedTesting = true;
      this.updateTrayMenu(this.isProxyRunning);
      this.onSpeedTest();
    }
  }

  private getSpeedTestLabel(): string {
    if (this.isSpeedTesting) {
      return mt('trayTestingSpeed');
    }
    return mt('traySpeedTest');
  }

  /**
   * 置「测速中」态（供非托盘入口——如服务器页/首页测速——也让托盘菜单显示 testing）。幂等：同态 no-op 不重建菜单。
   */
  setSpeedTesting(testing: boolean): void {
    if (this.isSpeedTesting === testing) return;
    this.isSpeedTesting = testing;
    this.updateTrayMenu(this.isProxyRunning);
  }

  /**
   * 置「按延迟排序」开关（供渲染端同步，使托盘节点列表与下拉同序）。幂等：同态 no-op 不重建菜单。
   * 无测速结果时排序退化为按名称（见 server-latency-sort），故 cold-start 结果未到达不影响顺序。
   */
  setSortByLatency(sortByLatency: boolean): void {
    if (this.sortByLatency === sortByLatency) return;
    this.sortByLatency = sortByLatency;
    this.updateTrayMenu(this.isProxyRunning);
  }

  /**
   * 更新测速结果（合并入托盘延迟显示）。
   * @param results 本次测速逐节点结果（可能是子集，如单节点 ⚡）。
   * @param opts.toast 是否广播完成汇总 toast（EVENT_SPEED_TEST_RESULT_LIST）；仅托盘入口触发的测速传 true——
   *   渲染入口（服务器页/首页）测速由 use-speed-test 自弹 toast，此处再弹会双 toast。
   *
   * **合并而非替换**：results 可能是子集（单节点测速 / 单飞 join 拿到的他人子集结果）；若整表替换会塌缩托盘
   * 已有的其余节点延迟。合并保留旧值、只更新本次测到的节点（与渲染层 applyLatencyResults 同语义）。
   */
  updateSpeedTestResults(
    results: Map<string, number | null>,
    servers: ServerConfig[],
    opts: {
      toast?: boolean;
      keepTestingState?: boolean;
      outcome?: SpeedTestOutcome;
      skipped?: number;
    } = {}
  ): void {
    this.speedTestResults = new Map([...this.speedTestResults, ...results]);
    // 出口伴测（keepTestingState）合并单节点结果时不复位「测速中」态——否则在飞的全量测速托盘态被伴测提前熄灭。
    if (!opts.keepTestingState) this.isSpeedTesting = false;
    this.updateTrayMenu(this.isProxyRunning);

    if (!opts.toast) return;

    // 仅列本次实际测速的节点：恒不可测节点（reverseMesh/custom-endpoint/无 exitNode 或未登录的 TS）经 isSpeedTestable
    // 及波前 gate 已不在 results（§16.1 path-aware：TS-exit 主核路径可在 results），与 buildServerItem 的 undefined→无徽标
    // 同口径，避免 toast 把「不适用/待入池」误报成「超时」。
    const resultList = servers
      .filter((s) => results.has(s.id))
      .map((s) => ({
        name: s.name || s.address,
        protocol: (s.protocol || '').toUpperCase(),
        latency: results.get(s.id) ?? null,
      }))
      .sort((a, b) => {
        if (a.latency === null) return 1;
        if (b.latency === null) return -1;
        return a.latency - b.latency;
      });

    // 发送 toast 事件（仅当窗口可见）：托盘触发的测速若窗口隐藏，结果已在托盘子菜单延迟徽标呈现，
    // 不再经此弹 in-app toast——否则用户稍后打开窗口才弹出已滞后的陈旧提示。空结果/不可测也不弹。
    // L-1：interrupted 即便 0 已测（起测即被打断）也须通知——否则托盘入口「测速中断」永不呈现。
    if (
      (resultList.length > 0 || opts.outcome === 'interrupted') &&
      this.mainWindow &&
      !this.mainWindow.isDestroyed() &&
      this.mainWindow.isVisible()
    ) {
      // §16.2：payload 从数组升级为 { outcome, items, skipped }——App.tsx 据 outcome 分「完成/中断」toast + 副行未纳入数。
      this.mainWindow.webContents.send(IPC_CHANNELS.EVENT_SPEED_TEST_RESULT_LIST, {
        outcome: opts.outcome ?? 'completed',
        items: resultList,
        skipped: opts.skipped ?? 0,
      });
    }
  }

  private updateTrayTooltip(): void {
    if (!this.tray) return;

    const tooltips: Record<TrayIconState, string> = {
      idle: mt('trayTooltipDisconnected'),
      connecting: mt('trayTooltipConnecting'),
      connected: mt('trayTooltipConnected'),
    };

    const tooltip = tooltips[this.currentState];

    this.tray.setToolTip(tooltip);
  }

  /**
   * 获取托盘是否已创建（用于测试）。语义同 hasTray，委托之避免双真值源日后分叉。
   */
  isTrayCreated(): boolean {
    return this.hasTray();
  }

  /**
   * 获取当前代理运行状态（用于测试）
   */
  getProxyRunningState(): boolean {
    return this.isProxyRunning;
  }

  /**
   * 获取当前图标状态（用于测试）
   */
  getCurrentIconState(): TrayIconState {
    return this.currentState;
  }

  /**
   * 获取当前选中的服务器ID（用于测试）
   */
  getSelectedServerId(): string | null {
    return this.selectedServerId;
  }

  /**
   * 获取当前代理模式（用于测试）
   */
  getProxyMode(): ProxyMode {
    return this.proxyMode;
  }

  /**
   * 进入轻量模式 (Public API)
   */
  enterLightweightMode(): void {
    this.handleLightweightMode();
  }
}
