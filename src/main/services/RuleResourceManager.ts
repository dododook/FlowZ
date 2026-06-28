/**
 * 规则资源管理：下载/校验/清单维护 + 动态资源库刷新 + GitHub 加速。
 * .srs 普遍 <1MB → 下载到内存校验魔数后原子落盘。并发池 3，批末一次性保存配置（避免逐项 saveConfig 互相覆盖）。
 */
import { net, type Session } from 'electron';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import { getRuleResourcesPath } from '../utils/paths';
import { MAX_GITHUB_JSON_BYTES } from '../utils/http-limits';
import { applyGhProxy, ghMirrorUrl, normalizeGhProxyPrefix } from '../../shared/gh-proxy';
import {
  mrdRawUrl,
  RULE_RESOURCE_CATALOG,
  findCatalogItem,
  deriveResourceMeta,
} from '../../shared/rule-resource-catalog';
import { APP_USER_AGENT } from '../../shared/constants';
import type { ConfigManager } from './ConfigManager';
import type {
  UserConfig,
  RuleResourceRef,
  RuleResource,
  RuleResourceCatalogItem,
  RuleResourceCatalogResult,
  RuleResourceDownloadItem,
  RuleResourceDownloadResult,
  RuleResourceListItem,
  RuleResourceProgress,
} from '../../shared/types';
import {
  BUILTIN_GEO_RULESETS,
  getRuleSetRuntimeDir,
  isBuiltinId,
  builtinIdFor,
  builtinTagFromId,
  findBuiltin,
} from './builtin-geo-rulesets';
import { enumerateResourceRefs, isResourceReferenced } from '../../shared/rule-resource-refs';
import { UpdateNetwork } from './UpdateNetwork';
import { resolveMainSessionViaProxy } from '../../shared/update-proxy';

const IDLE_TIMEOUT_MS = 15_000;
const OVERALL_TIMEOUT_MS = 120_000;
const MAX_SIZE = 64 * 1024 * 1024;
const POOL_SIZE = 3;
const GITHUB_HOSTS = ['raw.githubusercontent.com', 'github.com'];

type FetchResult =
  | { ok: true; buf: Buffer }
  | { ok: false; errorCode: string; statusCode?: number };

export class RuleResourceManager {
  private inflight = new Set<string>();
  private catalogCache: RuleResourceCatalogResult | null = null;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly emitProgress: (p: RuleResourceProgress) => void,
    private readonly broadcastConfigChanged: (config: UserConfig) => void,
    private readonly notifyCoreReload: (config: UserConfig) => void
  ) {}

  // Phase 1（更新网络统一层 §8）：更新链路统一会话层 + 代理运行态读取器，构造后由 index.ts 注入。
  // 未注入 → updateSession 返回 undefined（net.request 回落 default session，旧行为兜底）。
  private updateNetwork: UpdateNetwork | null = null;
  private proxyRunningProvider: (() => boolean) | null = null;
  // Phase 2：update-in inbound 动态端口读取器（proxyManager.getUpdateInPort）。viaProxy 时 pin 此口（非 mixedPort）。
  private updateInPortProvider: (() => number | null) | null = null;

  /** Phase 1/2：注入更新链路统一会话层 + 代理运行态读取器 + update-in 端口读取器（index.ts 装配）。 */
  setUpdateNetwork(
    updateNetwork: UpdateNetwork,
    proxyRunningProvider: () => boolean,
    updateInPortProvider: () => number | null
  ): void {
    this.updateNetwork = updateNetwork;
    this.proxyRunningProvider = proxyRunningProvider;
    this.updateInPortProvider = updateInPortProvider;
  }

  /**
   * Phase 1：资源下载统一会话。读 config(mainSessionViaProxy/mixedPort) + proxyRunning，经
   * resolveMainSessionViaProxy 决定经代理（socks 入站）还是直连；未注入 → undefined（net.request 回落
   * default session，旧行为兜底）。读 config 失败 → 直连兜底（绝不抛）。
   */
  private async updateSession(): Promise<Session | undefined> {
    if (!this.updateNetwork) return undefined;
    let viaProxy = false;
    let updateInPort = 0;
    try {
      const cfg = await this.configManager.loadConfig();
      const running = this.proxyRunningProvider ? this.proxyRunningProvider() : false;
      viaProxy = resolveMainSessionViaProxy(running, cfg.mainSessionViaProxy);
      updateInPort = this.updateInPortProvider?.() ?? 0;
    } catch {
      viaProxy = false; // 读 config 失败 → 直连兜底
    }
    // viaProxy 但 update-in 端口不可用（核未起/未分配）→ 直连兜底，不 pin 到无效端口
    if (viaProxy && updateInPort <= 0) viaProxy = false;
    // sessionFor 内部 setProxy 极罕见可能 reject → sessionForOrDirect 回落强制直连会话（绝不落 default session，
    // M1：对齐 CoreDownloader）；连 direct 也 reject（几乎不可能）才最终兜底 undefined 守 fetchBuffer/fetchJson 「永不 reject」契约。
    return this.updateNetwork.sessionForOrDirect(viaProxy, updateInPort).catch(() => undefined);
  }

  // 串行化所有 load-modify-save，防并发批次/删除/setGhProxy 在 load→save 窗口内交错丢写（review P2-1）
  private saveChain: Promise<unknown> = Promise.resolve();
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.saveChain.then(fn, fn);
    this.saveChain = run.catch(() => undefined);
    return run;
  }

  private dir(): string {
    return getRuleResourcesPath();
  }
  private catalogCachePath(): string {
    return path.join(this.dir(), 'catalog.json');
  }

  // ── 列表 ───────────────────────────────────────────────────────────────
  async list(): Promise<RuleResourceListItem[]> {
    const config = await this.configManager.loadConfig();
    const resources = config.ruleResources || [];
    const userItems: RuleResourceListItem[] = resources.map((r) => ({
      ...r,
      fileExists: fssync.existsSync(path.join(this.dir(), r.fileName)),
      referencedBy: this.referencingRules(config, r.id).length,
    }));
    // 用户资源按名称排序（中文拼音 / 英文字母 / 数字自然序，忽略大小写）；仅排展示副本，
    // config.ruleResources 存储顺序不动。内置 geo 不参与排序，固定置顶。
    userItems.sort((a, b) =>
      a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
    );
    // 内置 geo 规则集合成置顶（智能分流固定依赖；运行时落 <userData>/rules，与用户资源分目录）
    return [...this.listBuiltins(config), ...userItems];
  }

  /** 合成内置 geo 规则集列表项（虚拟条目，不存于 config.ruleResources）。fileExists 查运行时目录。 */
  private listBuiltins(config: UserConfig): RuleResourceListItem[] {
    const runtimeDir = getRuleSetRuntimeDir();
    const meta = config.builtinGeoMeta || {};
    return BUILTIN_GEO_RULESETS.map((b) => {
      const filePath = path.join(runtimeDir, b.fileName);
      let size = 0;
      let exists = false;
      try {
        size = fssync.statSync(filePath).size;
        exists = true;
      } catch {
        /* 运行时文件未就绪（首启动补种前）：exists=false */
      }
      return {
        id: builtinIdFor(b.tag),
        name: b.tag,
        category: b.category,
        sourceUrl: b.sourceUrl,
        fileName: b.fileName,
        format: 'binary' as const,
        size,
        downloadedAt: meta[b.tag]?.updatedAt || '', // 无记录=出厂版 → UI 显示「—」
        fileExists: exists,
        // 内置可被自定义规则经 res:builtin:<tag> 引用（D），计真实引用数；为 0 时 UI 回落显示「智能分流」（应用分流预设默认引用）。
        referencedBy: this.referencingRules(config, builtinIdFor(b.tag)).length,
        builtin: true,
      };
    });
  }

  // ── GitHub 加速设置 ──────────────────────────────────────────────────────
  async setGhProxy(prefix: string): Promise<{ ok: boolean; value?: string; error?: string }> {
    const normalized = prefix.trim() === '' ? '' : normalizeGhProxyPrefix(prefix);
    if (normalized === null) return { ok: false, error: 'invalid_proxy_host' };
    return this.withLock(async () => {
      const config = await this.configManager.loadConfig();
      config.ghProxyPrefix = normalized;
      await this.configManager.saveConfig(config);
      this.broadcastConfigChanged(config);
      return { ok: true, value: normalized };
    });
  }

  // ── 自动更新设置（专用通道，不走 config:save 以免触发重启）──────────────────
  async setAutoUpdate(args: {
    enabled: boolean;
    intervalHours?: number;
  }): Promise<{ ok: boolean }> {
    const allowed = [6, 12, 24, 72, 168];
    return this.withLock(async () => {
      const config = await this.configManager.loadConfig();
      config.ruleResourceAutoUpdate = !!args.enabled;
      if (args.intervalHours !== undefined) {
        config.ruleResourceUpdateIntervalHours = allowed.includes(args.intervalHours)
          ? args.intervalHours
          : 24;
      }
      await this.configManager.saveConfig(config);
      this.broadcastConfigChanged(config);
      return { ok: true };
    });
  }

  // ── 下载 ───────────────────────────────────────────────────────────────
  async download(
    items: RuleResourceDownloadItem[],
    opts?: { silent?: boolean }
  ): Promise<RuleResourceDownloadResult[]> {
    const config = await this.configManager.loadConfig();
    // 防手改配置注入非法前缀：读取侧再 normalize 一次兜底
    const raw = config.ghProxyPrefix;
    const prefix = raw ? (normalizeGhProxyPrefix(raw) ?? undefined) : undefined;

    const results = await this.runPool(items, POOL_SIZE, (item) =>
      this.downloadOne(item, prefix, opts?.silent)
    );

    const successes = results.filter(
      (r): r is RuleResourceDownloadResult & { resource: RuleResource } =>
        Boolean(r.ok && r.resource)
    );
    if (successes.length > 0) {
      // 批末一次性 upsert + 单次保存（并发下逐项保存会互相覆盖），并串行化防跨批次交错丢写
      await this.withLock(async () => {
        const fresh = await this.configManager.loadConfig();
        const existing = fresh.ruleResources || [];
        const byId = new Map(existing.map((r) => [r.id, r]));
        for (const s of successes) byId.set(s.resource.id, s.resource);
        fresh.ruleResources = Array.from(byId.values());
        await this.configManager.saveConfig(fresh);
        this.broadcastConfigChanged(fresh);
        // 仅当「被启用 ruleSet 引用 且 下载前文件不存在」才重启——已加载的 local rule_set 内容变更由
        // sing-box ≥1.10 fswatch 热重载，重启徒增断流；缺失补下才需重启挂载该 rule_set 条目。
        if (successes.some((s) => !s.existedBefore && isResourceReferenced(s.resource.id, fresh))) {
          this.notifyCoreReload(fresh);
        }
      });
    }
    return results;
  }

  /** catalog 项用 catalogId 重下；手动 URL 保留原 id/category 原地覆盖更新。 */
  private async buildRedownloadItem(res: RuleResource): Promise<RuleResourceDownloadItem> {
    const cat = await this.findCatalogItem(res.id);
    return cat
      ? { catalogId: res.id }
      : { url: res.sourceUrl, name: res.name, id: res.id, category: res.category };
  }

  async redownload(id: string): Promise<RuleResourceDownloadResult> {
    if (isBuiltinId(id)) return this.updateBuiltin(builtinTagFromId(id));
    const config = await this.configManager.loadConfig();
    const res = (config.ruleResources || []).find((r) => r.id === id);
    if (!res) return { ok: false, id, errorCode: 'http', error: 'resource not found' };
    const [r] = await this.download([await this.buildRedownloadItem(res)]);
    return r;
  }

  /** 批量更新（手动「全部更新」与自动更新调度共用）。silent 时不发进度事件（后台调度静默）。 */
  async updateMany(
    ids: string[],
    opts?: { silent?: boolean }
  ): Promise<RuleResourceDownloadResult[]> {
    if (ids.length === 0) return [];
    const builtinTags = ids.filter(isBuiltinId).map(builtinTagFromId);
    const userIds = ids.filter((id) => !isBuiltinId(id));
    const results: RuleResourceDownloadResult[] = [];
    if (userIds.length > 0) {
      const config = await this.configManager.loadConfig();
      const byId = new Map((config.ruleResources || []).map((r) => [r.id, r]));
      const items: RuleResourceDownloadItem[] = [];
      for (const id of userIds) {
        const res = byId.get(id);
        if (res) items.push(await this.buildRedownloadItem(res));
      }
      if (items.length > 0) results.push(...(await this.download(items, opts)));
    }
    // 内置串行更新（仅 3 项；各自原子写运行时目录 + 记录 builtinGeoMeta，不进 download 的批末入库流程）
    for (const tag of builtinTags) {
      results.push(await this.updateBuiltin(tag, opts));
    }
    return results;
  }

  /**
   * 补「磁盘文件缺失」的用户规则资源（重下载），**不受 ruleResourceAutoUpdate 开关 / 更新间隔门控**。
   * 备份恢复后调用：备份只含 config(ruleResources 元数据)、不含 .srs 本体 → 跨机/全新恢复后这些文件缺失 →
   * fail-closed 跳过引用规则；此处即时重下，download 内部对「引用中 + 之前缺失」资源触发 core reload → 规则恢复。
   * 仅补「缺失」（不重下已在的，避免恢复时全量重拉）。内置 geo 不在此：由 startInternal 从随包 bundle seed 补
   * （离线可用，无需联网）+ scheduler 兜底，故此处只管用户下载的外置资源。
   */
  async syncMissingNow(): Promise<{ missing: number; ok: number; failed: number }> {
    const config = await this.configManager.loadConfig();
    const dir = this.dir();
    const missing = (config.ruleResources || []).filter(
      (r) => !fssync.existsSync(path.join(dir, r.fileName))
    );
    if (missing.length === 0) return { missing: 0, ok: 0, failed: 0 };
    const items = await Promise.all(missing.map((r) => this.buildRedownloadItem(r)));
    const results = await this.download(items, { silent: true });
    const ok = results.filter((r) => r.ok).length;
    return { missing: missing.length, ok, failed: results.length - ok };
  }

  /** 枚举引用该资源的启用规则（路由规则 res:/geo 条件 + 应用分流 geo，单一真值见 shared/rule-resource-refs）。
   *  供 list 的 referencedBy 计数与删除确认分组展开复用——覆盖 geo 类型条件与 app 规则，删除提醒不再漏报。 */
  referencingRules(config: UserConfig, resId: string): RuleResourceRef[] {
    return enumerateResourceRefs(resId, config);
  }

  async delete(
    id: string,
    force = false
  ): Promise<{
    ok: boolean;
    needConfirm?: boolean;
    referencingRules?: RuleResourceRef[];
  }> {
    if (isBuiltinId(id)) return { ok: false }; // 内置不可删（UI 已隐藏删除入口；防旁路 IPC）
    return this.withLock(async () => {
      const config = await this.configManager.loadConfig();
      // 被启用规则引用且未确认 → 不删，回传引用规则明细供前端展开确认。删除后这些规则在 config 生成时被运行期 gate
      // 自动失效（值缺失跳过 / AND 条件坍缩整条 fail-closed），重下该资源后自动恢复——故仅提示、不改任何规则。
      if (!force) {
        const refs = this.referencingRules(config, id);
        if (refs.length > 0) return { ok: false, needConfirm: true, referencingRules: refs };
      }
      const res = (config.ruleResources || []).find((r) => r.id === id);
      config.ruleResources = (config.ruleResources || []).filter((r) => r.id !== id);
      await this.configManager.saveConfig(config);
      this.broadcastConfigChanged(config);
      if (res) {
        await fs.unlink(path.join(this.dir(), res.fileName)).catch(() => {});
        if (isResourceReferenced(id, config)) this.notifyCoreReload(config);
      }
      return { ok: true };
    });
  }

  private async downloadOne(
    item: RuleResourceDownloadItem,
    prefix: string | undefined,
    silent = false
  ): Promise<RuleResourceDownloadResult> {
    // 解析 id / name / category / sourceUrl
    let id: string;
    let name: string;
    let category: RuleResource['category'];
    let sourceUrl: string;
    if (item.catalogId) {
      const cat = await this.findCatalogItem(item.catalogId);
      if (!cat) return { ok: false, errorCode: 'http', error: 'unknown catalog id' };
      id = cat.id;
      name = cat.name;
      category = cat.category;
      sourceUrl = mrdRawUrl(cat.path);
    } else if (item.url) {
      // 主进程侧强制 https + .srs（渲染端已校验，这里防旁路 IPC）
      if (!/^https:\/\/.+\.srs$/i.test(item.url)) {
        return { ok: false, name: item.name, errorCode: 'http', error: 'url must be https .srs' };
      }
      const meta = deriveResourceMeta(item.url);
      category = item.category || meta.category;
      name = (item.name || '').trim() || meta.name;
      id = item.id || `res_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      sourceUrl = item.url;
    } else {
      return { ok: false, errorCode: 'http', error: 'no catalogId or url' };
    }

    if (this.inflight.has(id)) {
      return { ok: false, id, name, errorCode: 'in_progress', error: 'already downloading' };
    }
    this.inflight.add(id);
    const fileName = `${id}.srs`;

    const emit = (p: Partial<RuleResourceProgress> & Pick<RuleResourceProgress, 'status'>) => {
      if (silent) return; // 后台自动更新静默：不发进度事件，避免页面堆红行
      this.emitProgress({ id, name, received: 0, total: null, percent: null, ...p });
    };

    try {
      emit({ status: 'queued' });
      const onChunk = (received: number, total: number | null) =>
        emit({
          status: 'downloading',
          received,
          total,
          percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
        });

      const dest = path.join(this.dir(), fileName);
      const existedBefore = fssync.existsSync(dest); // 收窄重启判定用：已存在=内容更新（热重载）
      const stored = await this.fetchSrsToFile(sourceUrl, dest, prefix, onChunk);
      if (!stored.ok) {
        emit({ status: 'error', errorCode: stored.errorCode });
        return { ok: false, id, name, errorCode: stored.errorCode };
      }

      const resource: RuleResource = {
        id,
        name,
        category,
        sourceUrl,
        fileName,
        format: 'binary',
        size: stored.size,
        downloadedAt: new Date().toISOString(),
      };
      emit({ status: 'done', received: stored.size, total: stored.size, percent: 100 });
      return { ok: true, id, name, resource, existedBefore };
    } catch (e) {
      // fs 异常（磁盘满 / rename EPERM 等）不得逃出 worker，否则 Promise.all 整批 reject → 已成功项不入库
      emit({ status: 'error', errorCode: 'network' });
      return {
        ok: false,
        id,
        name,
        errorCode: 'network',
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      this.inflight.delete(id);
    }
  }

  /**
   * 抓取 .srs 到目标文件：gh-proxy 重试链（加速→直连→预设[0]）+ SRS 魔数校验 + tmp→rename 原子写。
   * user 资源（落 rule-resources 目录）与内置 geo（落 rules 运行时目录）共用，仅 destPath 不同。
   */
  private async fetchSrsToFile(
    sourceUrl: string,
    destPath: string,
    prefix: string | undefined,
    onChunk?: (received: number, total: number | null) => void
  ): Promise<{ ok: true; size: number } | { ok: false; errorCode: string }> {
    const finalUrl = applyGhProxy(prefix, sourceUrl);
    let r = await this.fetchBuffer(finalUrl, onChunk);
    if (!r.ok && prefix) r = await this.fetchBuffer(sourceUrl, onChunk);
    if (!r.ok && this.isGithub(sourceUrl)) {
      r = await this.fetchBuffer(ghMirrorUrl(sourceUrl), onChunk);
    }
    if (!r.ok) return { ok: false, errorCode: r.errorCode };
    // 内容校验：.srs 魔数 'SRS'（拦加速代理返回的 HTML 错误页）
    if (!(r.buf.length >= 3 && r.buf[0] === 0x53 && r.buf[1] === 0x52 && r.buf[2] === 0x53)) {
      return { ok: false, errorCode: 'invalid_content' };
    }
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    const tmp = `${destPath}.download`;
    try {
      await fs.writeFile(tmp, r.buf);
      await fs.rename(tmp, destPath);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {}); // 清理半写 tmp，避免运行时/资源目录脏文件堆积
      throw e;
    }
    return { ok: true, size: r.buf.length };
  }

  // ── 内置 geo 规则集（智能分流固定依赖；不可删，可更新/重置）────────────────────
  /** 设 builtinGeoMeta[tag].updatedAt（专用通道，不触发重启；内容热重载由 sing-box fswatch）。 */
  private async setBuiltinUpdatedAt(tag: string, at: string | null): Promise<void> {
    await this.withLock(async () => {
      const fresh = await this.configManager.loadConfig();
      const meta = { ...(fresh.builtinGeoMeta || {}) };
      if (at === null) delete meta[tag];
      else meta[tag] = { updatedAt: at };
      fresh.builtinGeoMeta = meta;
      await this.configManager.saveConfig(fresh);
      this.broadcastConfigChanged(fresh);
    });
  }

  /**
   * 更新内置 geo 规则集：从 SagerNet 源重下载到运行时目录（<userData>/rules）。
   * 同名 tmp→rename 原子替换 → sing-box ≥1.10 fswatch 热重载，零重启零断流（条目已在非 direct 模式挂载）。
   */
  async updateBuiltin(
    tag: string,
    opts?: { silent?: boolean }
  ): Promise<RuleResourceDownloadResult> {
    const b = findBuiltin(tag);
    const id = builtinIdFor(tag);
    if (!b) return { ok: false, id, errorCode: 'http', error: 'unknown builtin' };
    if (this.inflight.has(id)) {
      return { ok: false, id, name: b.tag, errorCode: 'in_progress', error: 'already downloading' };
    }
    this.inflight.add(id);
    const silent = opts?.silent ?? false;
    const emit = (p: Partial<RuleResourceProgress> & Pick<RuleResourceProgress, 'status'>) => {
      if (silent) return;
      this.emitProgress({ id, name: b.tag, received: 0, total: null, percent: null, ...p });
    };
    try {
      const config = await this.configManager.loadConfig();
      const raw = config.ghProxyPrefix;
      const prefix = raw ? (normalizeGhProxyPrefix(raw) ?? undefined) : undefined;
      emit({ status: 'queued' });
      const onChunk = (received: number, total: number | null) =>
        emit({
          status: 'downloading',
          received,
          total,
          percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
        });
      const dest = path.join(getRuleSetRuntimeDir(), b.fileName);
      const stored = await this.fetchSrsToFile(b.sourceUrl, dest, prefix, onChunk);
      if (!stored.ok) {
        emit({ status: 'error', errorCode: stored.errorCode });
        return { ok: false, id, name: b.tag, errorCode: stored.errorCode };
      }
      await this.setBuiltinUpdatedAt(tag, new Date().toISOString());
      emit({ status: 'done', received: stored.size, total: stored.size, percent: 100 });
      // existedBefore: true → 调用方（含 scheduler）不据此重启；内容更新走热重载
      return { ok: true, id, name: b.tag, existedBefore: true };
    } catch (e) {
      emit({ status: 'error', errorCode: 'network' });
      return {
        ok: false,
        id,
        name: b.tag,
        errorCode: 'network',
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      this.inflight.delete(id);
    }
  }

  /**
   * 重置内置规则集为出厂版：从随包 resources/data 复制覆盖运行时文件，清更新时间标记。
   * 给误更新坏数据一条退路；同样原子替换 → 热重载。
   */
  async resetBuiltin(tag: string): Promise<RuleResourceDownloadResult> {
    const b = findBuiltin(tag);
    const id = builtinIdFor(tag);
    if (!b) return { ok: false, id, errorCode: 'http', error: 'unknown builtin' };
    if (this.inflight.has(id)) {
      return { ok: false, id, name: b.tag, errorCode: 'in_progress', error: 'busy' };
    }
    this.inflight.add(id);
    try {
      const src = b.bundledPath();
      if (!fssync.existsSync(src)) {
        return {
          ok: false,
          id,
          name: b.tag,
          errorCode: 'invalid_content',
          error: 'bundled missing',
        };
      }
      const dest = path.join(getRuleSetRuntimeDir(), b.fileName);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.reset`;
      await fs.copyFile(src, tmp);
      await fs.rename(tmp, dest);
      await this.setBuiltinUpdatedAt(tag, null); // 回到「出厂版」状态
      return { ok: true, id, name: b.tag, existedBefore: true };
    } catch (e) {
      return {
        ok: false,
        id,
        name: b.tag,
        errorCode: 'network',
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      this.inflight.delete(id);
    }
  }

  private isGithub(url: string): boolean {
    try {
      return GITHUB_HOSTS.includes(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  private async fetchBuffer(
    url: string,
    onChunk?: (received: number, total: number | null) => void
  ): Promise<FetchResult> {
    const sess = await this.updateSession();
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: FetchResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(overall);
        clearTimeout(idle);
        resolve(v);
      };
      let received = 0;
      let total: number | null = null;
      const chunks: Buffer[] = [];
      const req = net.request({ url, redirect: 'follow', session: sess });
      req.setHeader('User-Agent', APP_USER_AGENT);

      let encoded = false; // 响应被压缩（content-encoding）→ data 为解压字节，content-length 是压缩长度，跳过比对
      let idle: NodeJS.Timeout;
      const resetIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          req.abort();
          done({ ok: false, errorCode: 'timeout' });
        }, IDLE_TIMEOUT_MS);
      };
      const overall = setTimeout(() => {
        req.abort();
        done({ ok: false, errorCode: 'timeout' });
      }, OVERALL_TIMEOUT_MS);
      resetIdle(); // 响应头到达前也看门狗，避免连接挂起需等满整体超时

      req.on('response', (res) => {
        const status = res.statusCode || 0;
        if (status >= 400) {
          req.abort();
          done({ ok: false, errorCode: 'http', statusCode: status });
          return;
        }
        const ce = res.headers['content-encoding'];
        const ceStr = (Array.isArray(ce) ? ce[0] : ce) || '';
        encoded = ceStr !== '' && ceStr.toLowerCase() !== 'identity';
        const cl = res.headers['content-length'];
        const clStr = Array.isArray(cl) ? cl[0] : cl;
        total = clStr ? parseInt(clStr, 10) : null;
        resetIdle();
        res.on('data', (c: Buffer) => {
          received += c.length;
          if (received > MAX_SIZE) {
            req.abort();
            done({ ok: false, errorCode: 'too_large' });
            return;
          }
          chunks.push(c);
          onChunk?.(received, total);
          resetIdle();
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          // 压缩响应下 content-length 是压缩长度，与解压字节数必不等 → 跳过比对（魔数+end 完整兜底）
          if (!encoded && total != null && buf.length !== total) {
            done({ ok: false, errorCode: 'size_mismatch' });
            return;
          }
          done({ ok: true, buf });
        });
        res.on('error', () => done({ ok: false, errorCode: 'network' }));
      });
      req.on('error', () => done({ ok: false, errorCode: 'network' }));
      req.end();
    });
  }

  // ── 资源库（catalog）：内置精选 + 动态刷新 ───────────────────────────────
  async getCatalog(): Promise<RuleResourceCatalogResult> {
    if (this.catalogCache) return this.catalogCache;
    // 尝试读磁盘缓存
    try {
      const raw = await fs.readFile(this.catalogCachePath(), 'utf-8');
      const parsed = JSON.parse(raw) as {
        schemaVersion?: number;
        fetchedAt: number;
        items: RuleResourceCatalogItem[];
      };
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.items) && parsed.items.length >= 50) {
        this.catalogCache = { items: parsed.items, fetchedAt: parsed.fetchedAt, source: 'cache' };
        return this.catalogCache;
      }
    } catch {
      /* 无缓存 */
    }
    return { items: RULE_RESOURCE_CATALOG, fetchedAt: null, source: 'builtin' };
  }

  async refreshCatalog(): Promise<RuleResourceCatalogResult> {
    try {
      const items = await this.fetchCatalogFromGithub();
      if (items.length < 50) throw new Error('catalog too small');
      const fetchedAt = Date.now();
      await fs.mkdir(this.dir(), { recursive: true });
      // 原子写：tmp → rename，与 .srs 落盘一致，防撕裂文件
      const cachePath = this.catalogCachePath();
      const tmp = `${cachePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ schemaVersion: 1, fetchedAt, items }), 'utf-8');
      await fs.rename(tmp, cachePath);
      this.catalogCache = { items, fetchedAt, source: 'remote' };
      return this.catalogCache;
    } catch (e) {
      // 刷新失败 → 保持现 catalog，抛错让 UI toast（区分限流）
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(/rate|403/i.test(msg) ? 'rate_limited' : 'refresh_failed');
    }
  }

  /**
   * 图标库拉取（规则自定义图标选择器）：下沉主进程经 update-in 统一会话（Phase 1b——取代 renderer 直接
   * fetch 走 default session；删 default session pin 后 manual 接管模式会退化直连）。两个图标库
   * （QureColor + edc）各多 CDN 源逐个兜底（jsdelivr/fastly/raw），合并 icons；全失败返 [] 优雅降级
   * （UI 回落手动输入图标 URL）。复用 fetchJson（带超时/OOM 防护 + update-in 会话）。
   */
  async fetchIconGalleries(): Promise<Array<{ name: string; url: string }>> {
    const fetchWithFallback = async (urls: string[]): Promise<any> => {
      for (const url of urls) {
        try {
          return await this.fetchJson(url);
        } catch {
          /* 当前源失败，尝试下一个 */
        }
      }
      return null;
    };
    const [qure, edc] = await Promise.all([
      fetchWithFallback([
        'https://cdn.jsdelivr.net/gh/Koolson/Qure/Other/QureColor-All.json',
        'https://fastly.jsdelivr.net/gh/Koolson/Qure/Other/QureColor-All.json',
        'https://raw.githubusercontent.com/Koolson/Qure/master/Other/QureColor-All.json',
      ]),
      fetchWithFallback([
        'https://cdn.jsdelivr.net/gh/erdongchanyo/icon@main/edc-filter-icon-gallery.json',
        'https://fastly.jsdelivr.net/gh/erdongchanyo/icon@main/edc-filter-icon-gallery.json',
        'https://raw.githubusercontent.com/erdongchanyo/icon/main/edc-filter-icon-gallery.json',
      ]),
    ]);
    return [...(qure?.icons || []), ...(edc?.icons || [])];
  }

  private async findCatalogItem(id: string): Promise<RuleResourceCatalogItem | undefined> {
    const builtin = findCatalogItem(id);
    if (builtin) return builtin;
    const cat = await this.getCatalog();
    return cat.items.find((i) => i.id === id);
  }

  private async fetchCatalogFromGithub(): Promise<RuleResourceCatalogItem[]> {
    const root = await this.fetchJson(
      'https://api.github.com/repos/MetaCubeX/meta-rules-dat/git/trees/sing'
    );
    const tree = (root?.tree || []) as Array<{ path: string; sha: string; type: string }>;
    const geoSha = tree.find((t) => t.path === 'geo')?.sha;
    const geoLiteSha = tree.find((t) => t.path === 'geo-lite')?.sha;
    if (!geoSha || !geoLiteSha) throw new Error('tree structure unexpected');

    const [geo, geoLite] = await Promise.all([
      this.fetchJson(
        `https://api.github.com/repos/MetaCubeX/meta-rules-dat/git/trees/${geoSha}?recursive=1`
      ),
      this.fetchJson(
        `https://api.github.com/repos/MetaCubeX/meta-rules-dat/git/trees/${geoLiteSha}?recursive=1`
      ),
    ]);
    if (geo?.truncated === true || geoLite?.truncated === true) throw new Error('tree truncated');

    const items: RuleResourceCatalogItem[] = [];
    const collect = (
      treeData: { tree?: Array<{ path: string; type: string }> },
      base: 'geo' | 'geo-lite'
    ) => {
      for (const node of treeData?.tree || []) {
        if (node.type !== 'blob' || !node.path.endsWith('.srs')) continue;
        const m = node.path.match(/^(geosite|geoip)\/(.+)\.srs$/);
        if (!m) continue;
        const kind = m[1]; // geosite | geoip
        const nm = m[2];
        if (nm.includes('/')) continue; // 嵌套子目录 → fileName 含 / 会写到子目录 ENOENT，跳过（P2-3）
        const category = (
          base === 'geo-lite' ? `${kind}-lite` : kind
        ) as RuleResourceCatalogItem['category'];
        const id = base === 'geo-lite' ? `${kind}-lite-${nm}` : `${kind}-${nm}`;
        items.push({ id, category, name: nm, path: `${base}/${node.path}` });
      }
    };
    collect(geo, 'geo');
    collect(geoLite, 'geo-lite');
    return items;
  }

  private async fetchJson(url: string): Promise<any> {
    const sess = await this.updateSession();
    return new Promise((resolve, reject) => {
      const req = net.request({ url, redirect: 'follow', session: sess });
      req.setHeader('User-Agent', APP_USER_AGENT);
      req.setHeader('Accept', 'application/vnd.github+json');
      const chunks: Buffer[] = [];
      const overall = setTimeout(() => {
        req.abort();
        reject(new Error('timeout'));
      }, 20_000);
      req.on('response', (res) => {
        const status = res.statusCode || 0;
        if (status === 403 || status === 429) {
          // 403 主限流 / 429 二级限流
          clearTimeout(overall);
          req.abort();
          reject(new Error('rate_limited'));
          return;
        }
        if (status >= 400) {
          clearTimeout(overall);
          req.abort();
          reject(new Error(`http ${status}`));
          return;
        }
        let received = 0;
        res.on('data', (c: Buffer) => {
          received += c.length;
          // OOM 防护（审计 #1）：GitHub git-trees JSON 被劫持/WAF 可回灌 GB 级 → chunks 无界 + Buffer.concat 峰值放大；
          // 两个 ?recursive=1 请求经 Promise.all 并发各持一份，更需上限。超 16MiB 即中止（catalog tree 实际 < 数 MB）。
          if (received > MAX_GITHUB_JSON_BYTES) {
            clearTimeout(overall);
            req.abort();
            reject(new Error('response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          clearTimeout(overall);
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
          } catch {
            reject(new Error('parse error'));
          }
        });
        res.on('error', () => {
          clearTimeout(overall);
          reject(new Error('network'));
        });
      });
      req.on('error', () => {
        clearTimeout(overall);
        reject(new Error('network'));
      });
      req.end();
    });
  }

  // ── 并发池 ───────────────────────────────────────────────────────────────
  private async runPool<T, R>(
    items: T[],
    limit: number,
    worker: (t: T, i: number) => Promise<R>
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (let i = next++; i < items.length; i = next++) {
          results[i] = await worker(items[i], i);
        }
      })
    );
    return results;
  }
}
