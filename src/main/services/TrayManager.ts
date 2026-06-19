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
import { ServerConfig, ProxyMode, ProxyModeType, SubscriptionConfig } from '../../shared/types';
import { groupServersBySubscription } from '../../shared/server-grouping';
import { DIRECT_SERVER_ID, isDirectSelection } from '../../shared/direct-selection';

// 托盘菜单状态圆点（macOS 系统色，18px 抗锯齿）——替代旧的 emoji 大圆圈，更克制现代。
const STATUS_DOT_PNG: Record<'connected' | 'disconnected' | 'error', string> = {
  connected:
    'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAABaklEQVR4nLWUsS9DURTGv3Pf5Un7eKKLRWJjYG3ErIv9LsR/ItGXGPwdGoa+3cIsYrXUJrEYVChafb29n0Ef9dpIVH3juef8zjk551xgTJIfXwkxsVEAEJvYQcDf4QkxVeNlzaZqPHB48kEjIWnmtXMzZ7VeBQBt7dXFevyQ9RkO6jkUT7ZnMC/7ALcAKfQe64Ac4467l5tHjSxMvkHKe7JUus3PTL6d6dAvdh7bQNc5AICn1MSsD/vUvmwkUxvXpwuvKEdMYeqz/9goRJELVPNAh34xuW8l6JIQURBR6JLJfSvRoV8MVPMAUeTSQXxV1Ctz+XSnEEzbG1GSo6VABlqnaCEdmy/PerFWqtTTWPVZDYAgb1eU7+VoHQYgH2mF1kH5Xi7I25X+WDXgPKLG2xoENFXj1UqVOh0Pdegrkh2wb1cIkuzo0Fd0PKyVKnVTNV46tbGN/x8WMgMDfnciwzWWo80C//SNjKB3ueTmNzrOQ7YAAAAASUVORK5CYII=',
  disconnected:
    'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAABmklEQVR4nLWUMW7bQBBF/wwlktgVUkQXyAGcVifIFaTCdxBSqCMMmAQMw42K2EV6Fy6WV8gJ0toHyAU2BSERJG3OpBBpKIxsIII91WL/zNvZnZkF3sjoNVFVKc9zBoD5fC5EpP9FV1VyzgXDfedcoKoHDx8dgnQnt+v1+iMQf94p1f1isfg98DkM6h3Oz799mE7DC4BOiTDdadZfX3+/8745I6JiCKN9SJqmZIyxUTT5Ya2dbTYbqKoAABHxZDLBdrv9WdebL2VZbtM01R7GPSjPc86yTMZjc2WtnRVF0YiIdj4sIloURWOtnY3H5irLMukL8ZxRn+bl5c00jvUX88i07RMR0V8Pq6oaBCMVeSqrij4lydL3sdxnAwBRxCdhGBuRFkNIdz0SaRGGsYkiPtmP5aHzsfbcbABQ1/LQNFXJHEBV/2k+VVXmAE1TlXUtD/ux3KWszrkgSZYeoFtrDQN43Id168edRrdJsvTOuaCv2puVf1iVVxoSHtA775uzLPv6ckMOYQAwHJHVavXiiBy0Y4b2fb+RY+wP33oSwpBBhJQAAAAASUVORK5CYII=',
  error:
    'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAABQklEQVR4nK2UTUoDQRCFv+qZNmMUF+YCLgRF4tLgAfQIvfEsggRc5BxZuMkR9ACSLAWJ4MILxIX4OxPmuZAJOhmFxHnL+nlV1a+qoSbYX06BEYIDYDDIDbQQu8AUQjRnDyHSL8XnjAIrKutwb5N4ZR+AaXpj17eP5ZhKoiJAne0NGuvnyE4wa305NcF0wcfzqQ3vn8pk9p2EM4zLnTVs9QrvO0wzyMkBcDhiD1k2RG9HHN+90EUFmZu1E4KzLjmW9PC+Q5qlCGE4DIcQaZbifQdLetYlnwlRdDQb6WC3hU8eMGuCrOINBSakV7L3LRuNJ0WuK7oBoJG0iVwTqVIIwJAgck0aSft7rqsIXgr1jmYghRDZaDzB1MfHDpHxc1eEyPCxw9S30XiiEKJCtdrkr38hy2Sw2IlUolajLRP+6xtZBp8CmLpNChT41AAAAABJRU5ErkJggg==',
};

/**
 * 托盘图标状态
 */
export type TrayIconState = 'idle' | 'connected' | 'connecting';

/**
 * 托盘菜单数据
 */
export interface TrayMenuData {
  isProxyRunning: boolean;
  hasError?: boolean;
  servers: ServerConfig[];
  subscriptions?: SubscriptionConfig[];
  selectedServerId: string | null;
  proxyMode: ProxyMode;
  proxyModeType: ProxyModeType;
}

/**
 * 托盘管理器接口
 */
export interface ITrayManager {
  /**
   * 创建托盘图标
   */
  createTray(): void;

  /**
   * 销毁托盘图标
   */
  destroyTray(): void;
  hasTray(): boolean;

  /**
   * 更新托盘图标状态
   */
  updateTrayIcon(state: TrayIconState): void;

  /**
   * 更新托盘菜单
   */
  updateTrayMenu(isProxyRunning: boolean): void;

  /**
   * 更新完整托盘菜单（包含服务器列表和代理模式）
   */
  updateFullTrayMenu(data: TrayMenuData): void;

  /**
   * 进入轻量模式
   */
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
  // 应用内语言设置，由渲染进程通过 IPC 同步过来，默认跟随系统
  private currentLanguage: string = app.getLocale?.() || 'zh-CN';

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

  /**
   * 设置主窗口引用
   */
  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  /**
   * 创建托盘图标
   */
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

  /**
   * 销毁托盘图标
   */
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

  /**
   * 更新托盘图标状态
   */
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

  /**
   * 设置应用语言（由主进程根据渲染进程 IPC 调用）
   */
  setLanguage(lang: string): void {
    this.currentLanguage = lang;
    // 重新渲染菜单以应用新语言
    this.updateTrayMenu(this.isProxyRunning);
  }

  /**
   * 获取本地化字符串（主进程托盘菜单用）
   * 根据应用语言配置决定显示中文还是英文
   */
  private t(zh: string, en: string): string {
    return this.currentLanguage.startsWith('zh') ? zh : en;
  }

  /**
   * 更新完整托盘菜单（包含服务器列表和代理模式）
   */
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

    // 状态显示：使用 emoji 区分不同状态
    // 🔵 蓝色 = 已连接，⚪ 灰色 = 已断开，🔴 红色 = 连接异常
    let statusLabel: string;
    let statusState: 'connected' | 'disconnected' | 'error';
    if (data.hasError) {
      statusLabel = this.t('连接异常', 'Connection Error');
      statusState = 'error';
    } else if (data.isProxyRunning) {
      statusLabel = this.t('已连接', 'Connected');
      statusState = 'connected';
    } else {
      statusLabel = this.t('已断开', 'Disconnected');
      statusState = 'disconnected';
    }

    // 构建服务器子菜单（按订阅/自建分组：单组平铺，多组用嵌套子菜单——节点多时更易导航）
    const serverSubmenu: MenuItemConstructorOptions[] = [];
    const maxLabelLength = 30;

    const buildServerItem = (server: ServerConfig): MenuItemConstructorOptions => {
      const name = server.name || server.address;
      const protocol = (server.protocol || '').toUpperCase();
      const latency = this.speedTestResults.get(server.id);
      const latencyStr =
        latency !== undefined
          ? latency !== null
            ? ` [${latency}ms]`
            : ` [${this.t('超时', 'Timeout')}]`
          : '';
      let label = `${name}（${protocol}）${latencyStr}`;
      if (label.length > maxLabelLength) {
        label = label.substring(0, maxLabelLength - 3) + '...';
      }
      return {
        label,
        type: 'radio' as const,
        checked: server.id === data.selectedServerId,
        click: () => this.handleSelectServer(server.id),
      };
    };

    // 「直连」置顶项（全局直连哨兵，#73）：与首页节点选择同概念、同步；选中即 proxy-selector→direct（热切换）。
    serverSubmenu.push({
      label: this.t('直连', 'Direct'),
      type: 'radio' as const,
      checked: isDirectSelection(data.selectedServerId),
      click: () => this.handleSelectServer(DIRECT_SERVER_ID),
    });
    serverSubmenu.push({ type: 'separator' });

    if (data.servers.length === 0) {
      serverSubmenu.push({
        label: this.t('未配置服务器', 'No Servers Configured'),
        enabled: false,
      });
      serverSubmenu.push({ type: 'separator' });
    } else {
      const groups = groupServersBySubscription(data.servers, data.subscriptions);
      if (groups.length <= 1) {
        // 单一来源：平铺
        data.servers.forEach((s) => serverSubmenu.push(buildServerItem(s)));
      } else {
        // 多来源：每个订阅/自建/组网一个子菜单
        for (const g of groups) {
          serverSubmenu.push({
            label: g.isMesh
              ? this.t('组网', 'Mesh')
              : g.isManual
                ? this.t('自建节点', 'Custom Nodes')
                : g.name,
            submenu: g.servers.map(buildServerItem),
          });
        }
      }
      serverSubmenu.push({ type: 'separator' });
    }

    // 添加"管理服务器"选项
    serverSubmenu.push({
      label: this.t('管理服务器', 'Manage Servers'),
      click: () => this.handleManageServers(),
    });

    // 代理模式标签映射
    const proxyModeLabels: Record<ProxyMode, string> = {
      global: this.t('全局代理', 'Global Proxy'),
      smart: this.t('智能分流', 'Smart Routing'),
      direct: this.t('直连模式', 'Direct Connection'),
    };

    // 构建代理模式子菜单
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
      systemProxy: this.t('系统代理', 'System Proxy'),
      tun: this.t('TUN 网卡', 'TUN'),
      manual: this.t('仅本地', 'Local Only'),
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
        label: this.t('打开主窗口', 'Open Main Window'),
        click: () => this.handleShowWindow(),
      },
      {
        label: data.isProxyRunning
          ? this.t('禁用代理', 'Disable Proxy')
          : this.t('启用代理', 'Enable Proxy'),
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
        label: this.t('选择服务器', 'Select Server'),
        submenu: serverSubmenu,
      },
      {
        label: this.t('接管方式', 'Takeover'),
        submenu: proxyModeTypeSubmenu,
      },
      {
        label: this.t('分流策略', 'Routing'),
        submenu: proxyModeSubmenu,
      },
      { type: 'separator' },
      {
        label: this.t('进入轻量模式', 'Enter Lightweight Mode'),
        click: () => this.handleLightweightMode(),
      },
      {
        label: this.t('进入隐私模式', 'Enter Privacy Mode'),
        click: () => this.handleEnterPrivacyMode(),
      },
      {
        label: this.t('打开设置', 'Open Settings'),
        click: () => this.handleOpenSettings(),
      },
      {
        label: this.t('检查更新', 'Check for Updates'),
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
        label: this.t('退出', 'Quit'),
        click: () => this.handleQuit(),
      },
    ]);

    this.tray.setContextMenu(contextMenu);
    this.logManager.addLog('debug', 'Tray menu updated', 'TrayManager');
  }

  /**
   * 加载托盘图标
   * 如果图标文件不存在，使用内置的默认图标
   */
  private loadTrayIcon(state: TrayIconState): Electron.NativeImage {
    const { resourceManager } = require('./ResourceManager');
    const iconPath = resourceManager.getTrayIconPath(state === 'connected');

    // 检查图标文件是否存在
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
      // 图标文件不存在，创建一个简单的默认图标
      this.logManager.addLog(
        'warn',
        `Tray icon not found: ${iconPath}, using default`,
        'TrayManager'
      );
      icon = this.createDefaultTrayIcon();
    }

    return icon;
  }

  /**
   * 创建默认托盘图标（当图标文件不存在时使用）
   */
  private createDefaultTrayIcon(): Electron.NativeImage {
    // 创建一个 22x22 的简单图标（V 字形状）
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

  /**
   * 处理托盘图标点击事件
   */
  private handleTrayClick(): void {
    this.logManager.addLog('info', 'Tray icon clicked', 'TrayManager');
    this.handleShowWindow();
  }

  /**
   * 处理启动代理
   */
  private handleStartProxy(): void {
    this.logManager.addLog('info', 'Start proxy clicked from tray', 'TrayManager');
    if (this.onStartProxy) {
      this.onStartProxy();
    }
  }

  /**
   * 处理停止代理
   */
  private handleStopProxy(): void {
    this.logManager.addLog('info', 'Stop proxy clicked from tray', 'TrayManager');
    if (this.onStopProxy) {
      this.onStopProxy();
    }
  }

  /**
   * 处理进入轻量模式
   */
  private handleLightweightMode(): void {
    this.logManager.addLog('info', 'Enter lightweight mode clicked from tray', 'TrayManager');
    if (this.onLightweightMode) {
      this.onLightweightMode();
    } else if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      // 销毁窗口，释放整个 Chromium 渲染进程（最大内存释放）
      this.mainWindow.destroy();
      this.logManager.addLog('info', 'Main window destroyed for lightweight mode', 'TrayManager');

      // 窗口销毁后执行主进程内存清理：
      // 1. 清空日志缓冲区（释放 5-10MB 内存中积累的日志对象）
      // 2. 触发 V8 GC（回收孤立的闭包、IPC handler 引用、缓存 config 对象等，约 15-25MB）
      // 延迟 500ms 等待窗口销毁事件完全传播
      setTimeout(() => {
        // 清空内存日志缓冲区（只清内存，不删磁盘日志文件）
        this.logManager.clearLogs();

        // 手动触发 V8 GC（需要启动时已调用 v8.setFlagsFromString('--expose-gc')）
        if (typeof (global as any).gc === 'function') {
          (global as any).gc();
        }
      }, 500);
    }
  }

  /**
   * 处理进入隐私模式
   */
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

  /**
   * 处理退出应用
   */
  private handleQuit(): void {
    this.logManager.addLog('info', 'Quit clicked from tray', 'TrayManager');
    if (this.onQuit) {
      this.onQuit();
    } else {
      app.quit();
    }
  }

  /**
   * 处理选择服务器
   */
  private handleSelectServer(serverId: string): void {
    this.logManager.addLog('info', `Server selected from tray: ${serverId}`, 'TrayManager');
    if (this.onSelectServer) {
      this.onSelectServer(serverId);
    }
  }

  /**
   * 处理切换代理模式
   */
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

  /**
   * 处理打开设置
   */
  private handleOpenSettings(): void {
    this.logManager.addLog('info', 'Open settings clicked from tray', 'TrayManager');
    if (this.onOpenSettings) {
      this.onOpenSettings();
    } else {
      // 默认行为：显示窗口并导航到设置页面
      this.handleShowWindow();
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('navigate', '/settings');
      }
    }
  }

  /**
   * 处理检查更新
   */
  private handleCheckUpdate(): void {
    this.logManager.addLog('info', 'Check update clicked from tray', 'TrayManager');
    if (this.onCheckUpdate) {
      this.onCheckUpdate();
    } else {
      // 默认行为：打开 GitHub releases 页面
      shell.openExternal('https://github.com/dododook/FlowZ/releases');
    }
  }

  /**
   * 处理管理服务器
   */
  private handleManageServers(): void {
    this.logManager.addLog('info', 'Manage servers clicked from tray', 'TrayManager');
    if (this.onManageServers) {
      this.onManageServers();
    } else {
      // 默认行为：显示窗口并导航到服务器页面
      this.handleShowWindow();
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('navigate', '/server');
      }
    }
  }

  /**
   * 处理测速
   */
  private handleSpeedTest(): void {
    this.logManager.addLog('info', 'Speed test clicked from tray', 'TrayManager');
    if (this.onSpeedTest) {
      this.isSpeedTesting = true;
      this.updateTrayMenu(this.isProxyRunning);
      this.onSpeedTest();
    }
  }

  /**
   * 获取测速菜单项标签
   */
  private getSpeedTestLabel(): string {
    if (this.isSpeedTesting) {
      return this.t('测速中...', 'Testing Speed...');
    }
    return this.t('服务器测速', 'Speed Test');
  }

  /**
   * 更新测速结果
   */
  updateSpeedTestResults(results: Map<string, number | null>, servers: ServerConfig[]): void {
    this.speedTestResults = results;
    this.isSpeedTesting = false;
    this.updateTrayMenu(this.isProxyRunning);

    const resultList = servers
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

    // 发送到渲染进程显示 toast
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('speedTestResult', resultList);
    }
  }

  /**
   * 更新托盘 tooltip
   */
  private updateTrayTooltip(): void {
    if (!this.tray) return;

    const tooltips: Record<TrayIconState, string> = {
      idle: this.t('FlowZ - 未连接', 'FlowZ - Disconnected'),
      connecting: this.t('FlowZ - 连接中...', 'FlowZ - Connecting...'),
      connected: this.t('FlowZ - 已连接', 'FlowZ - Connected'),
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
