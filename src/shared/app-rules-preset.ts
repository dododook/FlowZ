import { CustomAppPreset, AppRule, RuleAction } from './types';

/** 每个应用对应一个或多个 geosite 标签，底层映射到 sing-box 的 rule_set 机制。 */

export interface AppPreset {
  id: string;
  /** i18n key，对应 rules.apps.XXX */
  labelKey: string;
  /** iconUrl 加载失败时的兜底图标 */
  emoji: string;
  /** Qure Color 彩色图标集 */
  iconUrl?: string;
  geositeTags: string[];
  geoipTags?: string[];
  /** 用于跨平台（macOS/Windows/Linux）按进程名精准分流 */
  processNames?: string[];
  category: 'video' | 'social' | 'ai' | 'tools' | 'game';
}

const QURE_BASE = 'https://fastly.jsdelivr.net/gh/Koolson/Qure/IconSet/Color';

export const APP_PRESETS: AppPreset[] = [
  // ── 视频 ──────────────────────────────────────────
  {
    id: 'youtube',
    labelKey: 'youtube',
    emoji: '▶️',
    iconUrl: `${QURE_BASE}/YouTube.png`,
    geositeTags: ['youtube'],
    category: 'video',
  },
  {
    id: 'netflix',
    labelKey: 'netflix',
    emoji: '🎬',
    iconUrl: `${QURE_BASE}/Netflix.png`,
    geositeTags: ['netflix'],
    // geoip-netflix 覆盖 Netflix 的 CDN 直连 IP（如 AWS/Akamai 上的 Netflix 专属 IP 段）
    geoipTags: ['netflix'],
    processNames: ['Netflix', 'Netflix.exe'],
    category: 'video',
  },
  {
    id: 'tiktok',
    labelKey: 'tiktok',
    emoji: '🎵',
    iconUrl: `${QURE_BASE}/TikTok.png`,
    geositeTags: ['tiktok'],
    processNames: ['TikTok', 'TikTok.exe'],
    category: 'video',
  },
  // ── 社交 ──────────────────────────────────────────
  {
    id: 'telegram',
    labelKey: 'telegram',
    emoji: '✈️',
    iconUrl: `${QURE_BASE}/Telegram.png`,
    geositeTags: ['telegram'],
    // geoip-telegram 覆盖 Telegram DC（数据中心）的 IP 段，确保 DC IP 直连也走代理
    geoipTags: ['telegram'],
    processNames: ['Telegram', 'Telegram.exe', 'Telegram Desktop'],
    category: 'social',
  },
  {
    id: 'twitter',
    labelKey: 'twitter',
    emoji: '🐦',
    iconUrl: `${QURE_BASE}/X.png`,
    geositeTags: ['twitter'],
    // geoip-twitter 覆盖 Twitter/X 使用 QUIC 协议时直连的 IP 段
    // 这是修复 Twitter 在系统代理模式下 UDP 流量不走代理的关键
    geoipTags: ['twitter'],
    processNames: ['Twitter', 'X', 'Twitter.exe'],
    category: 'social',
  },
  {
    id: 'instagram',
    labelKey: 'instagram',
    emoji: '📷',
    iconUrl: `${QURE_BASE}/Instagram.png`,
    geositeTags: ['instagram'],
    processNames: ['Instagram', 'Instagram.exe'],
    category: 'social',
  },
  // ── AI ────────────────────────────────────────────
  {
    id: 'openai',
    labelKey: 'openai',
    emoji: '🤖',
    iconUrl: `${QURE_BASE}/ChatGPT.png`,
    geositeTags: ['openai'],
    processNames: ['ChatGPT', 'ChatGPT.exe'],
    category: 'ai',
  },
  {
    id: 'anthropic',
    labelKey: 'anthropic',
    emoji: '🧠',
    iconUrl:
      'https://raw.githubusercontent.com/lige47/QuanX-icon-rule/main/icon/04ProxySoft/claude.png',
    // 注意：SagerNet geosite 数据库中没有独立的 geosite-anthropic.srs
    // 使用 geosite-category-ai 兜底（包含 OpenAI/Anthropic/Gemini 等主流 AI 服务）
    // 同时加入 claude.ai 域名通过自定义规则覆盖
    geositeTags: ['anthropic', 'category-ai'],
    processNames: ['Claude', 'Claude.exe'],
    category: 'ai',
  },
  {
    id: 'gemini',
    labelKey: 'gemini',
    emoji: '✨',
    iconUrl:
      'https://raw.githubusercontent.com/lige47/QuanX-icon-rule/main/icon/04ProxySoft/gemini.png',
    // 使用 geosite-google 同时覆盖 Gemini 所有相关域名（gemini.google.com 等）
    // 注意：如果用户同时启用了 Google 应用分流，两者共享同一个 rule_set 不会冲突
    // sing-box 会自动去重，不会重复下载
    geositeTags: ['google'],
    category: 'ai',
  },
  // ── 工具 ──────────────────────────────────────────
  {
    id: 'github',
    labelKey: 'github',
    emoji: '🐙',
    iconUrl: `${QURE_BASE}/GitHub.png`,
    geositeTags: ['github'],
    processNames: ['GitHub Desktop', 'GitHubDesktop.exe', 'git', 'git.exe', 'GitHub'],
    category: 'tools',
  },
  {
    id: 'google',
    labelKey: 'google',
    emoji: '🔍',
    iconUrl: `${QURE_BASE}/Google_Search.png`,
    geositeTags: ['google'],
    category: 'tools',
  },
  {
    id: 'spotify',
    labelKey: 'spotify',
    emoji: '🎧',
    iconUrl: `${QURE_BASE}/Spotify.png`,
    geositeTags: ['spotify'],
    processNames: ['Spotify', 'Spotify.exe'],
    category: 'tools',
  },
  // ── 游戏 ──────────────────────────────────────────
  {
    id: 'steam',
    labelKey: 'steam',
    emoji: '🎮',
    iconUrl: `${QURE_BASE}/Steam.png`,
    geositeTags: ['steam'],
    // 包含 Steam 客户端及常见热门游戏的进程名
    // 游戏通过 Steam 启动后是独立进程，仅匹配 "Steam" 无法覆盖游戏本体的 UDP 流量
    processNames: [
      // Steam 客户端及辅助进程
      'Steam',
      'steam.exe',
      'steamwebhelper',
      'steamwebhelper.exe',
      'GameOverlayUI.exe',
      'GameOverlayUI',
      'steam_osx', // macOS Steam binary
      // 热门 FPS / 竞技游戏
      'cs2',
      'cs2.exe', // CS2 (Counter-Strike 2)
      'dota2',
      'dota2.exe', // Dota 2
      'TslGame.exe',
      'TslGame', // PUBG
      'r5apex.exe',
      'r5apex', // Apex Legends
      'EscapeFromTarkov.exe', // Escape from Tarkov
      'FortniteClient-Win64-Shipping.exe', // Fortnite (via Epic on Steam)
      // MOBA / RPG
      'Hearthstone.exe',
      'Hearthstone', // 炉石传说
      'GenshinImpact.exe',
      'YuanShen.exe', // 原神
      'StarRail.exe', // 崩坏：星穹铁道
      'ZenlessZoneZero.exe', // 绝区零
      // 生存 / 沙盒
      'valheim.exe',
      'valheim', // Valheim
      'RustClient.exe', // Rust
      'Palworld-Win64-Shipping.exe', // Palworld 幻兽帕鲁
    ],
    category: 'game',
  },
  {
    id: 'epic',
    labelKey: 'epic',
    emoji: '🎮',
    iconUrl:
      'https://raw.githubusercontent.com/lige47/QuanX-icon-rule/main/icon/07Game/epicgames.png',
    geositeTags: ['epicgames'],
    processNames: [
      'EpicGamesLauncher',
      'EpicGamesLauncher.exe',
      'EpicWebHelper.exe',
      'FortniteClient-Win64-Shipping.exe',
      'UnrealEngineLauncher.exe',
    ],
    category: 'game',
  },
  {
    id: 'riot',
    labelKey: 'riot',
    emoji: '⚔️',
    iconUrl: 'https://raw.githubusercontent.com/lige47/QuanX-icon-rule/main/icon/07Game/riot.png',
    geositeTags: ['riot'],
    processNames: [
      'RiotClientServices.exe',
      'RiotClientServices',
      'LeagueClient.exe',
      'LeagueClient', // 英雄联盟客户端
      'League of Legends.exe',
      'League of Legends', // 英雄联盟游戏
      'VALORANT-Win64-Shipping.exe', // Valorant
      'LoR.exe', // Legends of Runeterra
    ],
    category: 'game',
  },
  {
    id: 'disney',
    labelKey: 'disney',
    emoji: '🏰',
    iconUrl: `${QURE_BASE}/Disney.png`,
    geositeTags: ['disney'],
    processNames: ['Disney+'],
    category: 'video',
  },
];

/** 根据 appId 快速查找预设（支持从用户自定义列表中查找） */
export function getAppPreset(
  appId: string,
  customPresets?: CustomAppPreset[]
): AppPreset | undefined {
  const builtin = APP_PRESETS.find((p) => p.id === appId);
  if (builtin) return builtin;

  if (customPresets) {
    const custom = customPresets.find((p) => p.id === appId);
    if (custom) {
      return {
        id: custom.id,
        labelKey: custom.name, // 自定义应用直接存储名称
        emoji: custom.emoji,
        iconUrl: custom.iconUrl,
        geositeTags: custom.geositeTags,
        geoipTags: custom.geoipTags,
        // 进程名透传给配置生成（与内置预设同一消费点）；自定义应用亦可按进程名精准分流。
        processNames: custom.processNames,
        category: 'tools', // 后端不消费 category；分组呈现由渲染层直接读 custom.category（此处仅占位满足类型）
      };
    }
  }

  return undefined;
}

export function getAppPresetsByCategory(category: AppPreset['category']): AppPreset[] {
  return APP_PRESETS.filter((p) => p.category === category);
}

/**
 * 默认应用分流规则：为每个内置预设生成「代理·跟全局」规则（enabled，无 targetServerId）。
 * 使每张卡片启动即有 rule-sel-app selector → 首次切节点即热切换，无需先手动触发一次创建规则。
 */
export function defaultAppRules(): AppRule[] {
  return APP_PRESETS.map((p) => ({
    appId: p.id,
    action: 'proxy' as RuleAction,
    enabled: true,
  }));
}

/**
 * 一次性默认注入合并（幂等）：为未配置的预设补默认规则；剔除已下线预设（如 apple/bilibili）的残留规则；
 * 保留用户已配置的预设规则（不覆盖其 action/目标节点）与自定义 app（custom-*）。
 */
export function seedDefaultAppRules(existing: AppRule[]): AppRule[] {
  const validIds = new Set(APP_PRESETS.map((p) => p.id));
  const kept = existing.filter((r) => validIds.has(r.appId) || r.appId.startsWith('custom-'));
  const have = new Set(kept.map((r) => r.appId));
  return [...kept, ...defaultAppRules().filter((r) => !have.has(r.appId))];
}
