/**
 * 内置 geo 规则集（geosite-cn / geosite-geolocation-!cn / geoip-cn）的单一真值表。
 *
 * 这三件套随 app 分发（resources/data → process.resourcesPath/data，见 electron-builder.json），
 * 智能分流/全局模式的本地 rule_set（type:local）引用它们，路由生成与拷贝落地共用本表，杜绝目录/文件名漂移。
 *
 * 运行时文件落 <userData>/rules/<tag>.srs（与「规则资源」页用户下载的 <userData>/rule-resources/ 分目录）。
 * - 出厂源 bundledPath()：seed-if-missing 与「重置为出厂」用。
 * - 网络更新源 sourceUrl：SagerNet rule-set 分支（与出厂数据同源，零漂移），走 RuleResourceManager 的 gh-proxy 重试链。
 *
 * 不再「每次启动无条件覆盖」——改 seed-if-missing-or-invalid（见 seedBuiltinRuleSets），
 * 否则网络更新成功的新版本会在下次启动被出厂版静默回滚。
 */
import * as path from 'path';
import * as fssync from 'fs';
import * as fsp from 'fs/promises';
import { getUserDataPath } from '../utils/paths';
import { resourceManager } from './ResourceManager';
import type { RuleResourceCategory } from '../../shared/types';

export const BUILTIN_ID_PREFIX = 'builtin:';

export interface BuiltinGeoRuleSet {
  /** sing-box rule_set tag，同时是运行时文件名前缀。 */
  tag: string;
  /** 运行时落盘名 `${tag}.srs`。 */
  fileName: string;
  category: RuleResourceCategory;
  /** 出厂源（resources/data 内随包分发），seed / reset 用。 */
  bundledPath: () => string;
  /** 网络更新源（SagerNet rule-set raw，复用下载层 gh-proxy 重试链）。 */
  sourceUrl: string;
}

/**
 * 内置应用分流预设（APP_PRESETS）引用的 geo 标签 —— 随包 bundle 成本地 rule_set。
 * 目的：应用分流**离线可用、无启动期下载、不会因源 404 FATAL**；自动更新+fswatch 热加载保持新鲜。
 * 机制：getLocalGeoRuleSets 把它们注入为 type:'local'，与 generateRouteConfig 的远程 app-rule rule_set **同 tag 撞名**，
 *   经 rule_set 去重（本地优先于远程）自动改用本地副本——故无需改 app-rule 生成逻辑。源 = MetaCubeX/meta-rules-dat@sing
 *   （与远程 app-rule rule_set 同源；文件已随包于 resources/data）。
 */
const APP_GEOSITE_TAGS = [
  'youtube',
  'netflix',
  'tiktok',
  'telegram',
  'twitter',
  'instagram',
  'openai',
  'anthropic',
  'category-ai',
  'google',
  'github',
  'spotify',
  'steam',
  'epicgames',
  'riot',
  'disney',
  'private',
];
const APP_GEOIP_TAGS = ['netflix', 'telegram', 'twitter', 'private'];

// 地区分流场景（4.1.0）：伊朗/俄罗斯本地 geo —— 随包 bundle（resources/data），本地优先、离线可用。
// CN 用上方三件套（geosite-cn / geosite-geolocation-!cn / geoip-cn），故此处只补 ir/ru。
const REGION_GEOSITE_TAGS = ['category-ir', 'category-ru'];
const REGION_GEOIP_TAGS = ['ir', 'ru'];

const MRD_GEO_RAW = 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo';
const appGeoEntry = (cat: 'geosite' | 'geoip', tag: string): BuiltinGeoRuleSet => {
  // category-ai 在 MetaCubeX 用 category-ai-!cn（裸 category-ai 不单独成 .srs）；tag 仍为 geosite-category-ai（与 app-rule 生成对齐）。
  const srcName = cat === 'geosite' && tag === 'category-ai' ? 'category-ai-!cn' : tag;
  const fileName = `${cat}-${srcName}.srs`;
  return {
    tag: `${cat}-${tag}`,
    fileName,
    category: cat,
    bundledPath: () => resourceManager.getDataResourcePath(fileName),
    sourceUrl: `${MRD_GEO_RAW}/${cat}/${srcName}.srs`,
  };
};

export const BUILTIN_GEO_RULESETS: BuiltinGeoRuleSet[] = [
  {
    tag: 'geosite-cn',
    fileName: 'geosite-cn.srs',
    category: 'geosite',
    bundledPath: () => resourceManager.getGeoSiteCNPath(),
    sourceUrl: 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs',
  },
  {
    tag: 'geosite-geolocation-!cn',
    fileName: 'geosite-geolocation-!cn.srs',
    category: 'geosite',
    bundledPath: () => resourceManager.getGeoSiteNonCNPath(),
    sourceUrl:
      'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-geolocation-!cn.srs',
  },
  {
    tag: 'geoip-cn',
    fileName: 'geoip-cn.srs',
    category: 'geoip',
    bundledPath: () => resourceManager.getGeoIPPath(),
    sourceUrl: 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs',
  },
  // 内置应用分流预设的 geo（随包，本地优先）
  ...APP_GEOSITE_TAGS.map((t) => appGeoEntry('geosite', t)),
  ...APP_GEOIP_TAGS.map((t) => appGeoEntry('geoip', t)),
  // 地区分流场景的 geo（伊朗/俄罗斯，随包本地优先；CN 已在上方三件套）
  ...REGION_GEOSITE_TAGS.map((t) => appGeoEntry('geosite', t)),
  ...REGION_GEOIP_TAGS.map((t) => appGeoEntry('geoip', t)),
];

/** 本地 geo 规则集运行时目录（内置 .srs 拷贝落地处）。copy 与 route 生成共用，单一真值。 */
export function getRuleSetRuntimeDir(): string {
  return path.join(getUserDataPath(), 'rules');
}

export const isBuiltinId = (id: string): boolean => id.startsWith(BUILTIN_ID_PREFIX);
export const builtinIdFor = (tag: string): string => `${BUILTIN_ID_PREFIX}${tag}`;
export const builtinTagFromId = (id: string): string => id.slice(BUILTIN_ID_PREFIX.length);
export const findBuiltin = (tag: string): BuiltinGeoRuleSet | undefined =>
  BUILTIN_GEO_RULESETS.find((b) => b.tag === tag);

/**
 * 解析 `res:builtin:<tag>` 引用为 rule_set 定义所需的元数据：tag=复用 b.tag（与 getLocalGeoRuleSets 注入的本地
 * rule_set 同 tag，route 装配末尾按 tag 去重 keep-first），fileName=运行时文件名。
 *
 * **纯函数（不查 FS）**：非内置 id / 未知 tag → null。FS 守卫（isValidSrsFile）由调用方在拼出 runtime 路径后施加，
 * 与 getLocalGeoRuleSets 的「缺失即跳过」一致（不引用不存在的 rule_set，否则 sing-box initialize rule-set FATAL）。
 * 抽成纯函数便于单测（见 __tests__/builtin-ruleset-ref.test.ts），与 ProxyManager.generateCustomRules 的 res: 分支共享单一真值。
 */
export function resolveBuiltinRuleSetRefMeta(
  resId: string
): { tag: string; fileName: string } | null {
  if (!isBuiltinId(resId)) return null;
  const b = findBuiltin(builtinTagFromId(resId));
  if (!b) return null;
  return { tag: b.tag, fileName: b.fileName };
}

/** SRS 文件魔数校验（'SRS' = 0x53 0x52 0x53），拦半写/损坏文件。同步读前 3 字节。 */
export function isValidSrsFile(p: string): boolean {
  let fd: number | null = null;
  try {
    fd = fssync.openSync(p, 'r');
    const buf = Buffer.alloc(3);
    const n = fssync.readSync(fd, buf, 0, 3, 0);
    return n === 3 && buf[0] === 0x53 && buf[1] === 0x52 && buf[2] === 0x53;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fssync.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

let seedCounter = 0;

/**
 * 内置 geo 规则集落地（原子 tmp→rename，防 TUN 特权进程读半写文件；单项失败不抛、不阻断其余项；幂等）：
 * - **缺失/损坏必种**（seed-if-missing-or-invalid）。
 * - `refreshOutOfBox`（仅启动时传）：**出厂态**（无网络更新记录 = `builtinGeoMeta[tag].updatedAt` 缺失）下，
 *   若 bundled 与 runtime 文件大小不一致（=app 升级带来新出厂数据）→ 刷新为新出厂版。
 *   **已网络更新的文件永不被覆盖**（有 updatedAt 即不在刷新范围）。仅启动时启用——此刻无并发 updateBuiltin，
 *   刷新落地无竞态；运行中（代理启动）的补种只做「缺失补种」，不与并发更新争抢。
 *
 * 这同时修复「seed-if-missing 后出厂态用户跨 app 升级冻结在首装版」的回归（旧逻辑每次启动无条件覆盖）。
 */
export async function seedBuiltinRuleSets(opts?: {
  builtinGeoMeta?: Record<string, { updatedAt?: string }>;
  refreshOutOfBox?: boolean;
}): Promise<void> {
  const runtimeDir = getRuleSetRuntimeDir();
  for (const b of BUILTIN_GEO_RULESETS) {
    const dest = path.join(runtimeDir, b.fileName);
    const src = b.bundledPath();
    const outOfBox = !opts?.builtinGeoMeta?.[b.tag]?.updatedAt;
    let reason: 'missing' | 'refresh' | null = null;
    if (!isValidSrsFile(dest)) reason = 'missing';
    else if (opts?.refreshOutOfBox && outOfBox) {
      // 出厂态 + app 升级带来新出厂数据（大小不一致）→ 刷新；stat 失败则不强制
      try {
        if (fssync.existsSync(src) && fssync.statSync(src).size !== fssync.statSync(dest).size) {
          reason = 'refresh';
        }
      } catch {
        /* keep null */
      }
    }
    if (!reason) continue;
    try {
      if (!fssync.existsSync(src)) continue; // 出厂文件缺失（异常打包）→ 跳过，由网络更新兜底
      await fsp.mkdir(runtimeDir, { recursive: true });
      const tmp = `${dest}.seed-${process.pid}-${seedCounter++}`;
      await fsp.copyFile(src, tmp);
      // 落地前复查：missing 场景若 dest 期间已被 updateBuiltin 写入合法文件 → 放弃覆盖（防竞态回滚网络版）
      if (reason === 'missing' && isValidSrsFile(dest)) {
        await fsp.unlink(tmp).catch(() => {});
      } else {
        await fsp.rename(tmp, dest);
      }
    } catch {
      /* 单项补种失败不阻塞其余项；下次启动/列表刷新再试 */
    }
  }
}
