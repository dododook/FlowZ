/**
 * CLI / 非 GUI 早退（纯函数判定 + IO 注入编排，便于单测；实际副作用由 index.ts 注入的 io 执行）。
 *
 * 背景：FlowZ 是 Electron GUI app，main 进程默认走 `whenReady → createWindow` 路径。在无显示服务环境
 * （SSH / CI / headless / `flowz -V` 查版本）启动时，Electron GUI 平台（Ozone/X11）初始化失败
 * （"Missing X server or $DISPLAY" / "platform failed to initialize"），且 native 层清理不净 → 进程卡死、
 * 用户 Ctrl-C 后 segfault(core dumped)。CLI 查询（-V/-h）本不需要 GUI。
 *
 * 早退在 Electron GUI 初始化（requestSingleInstanceLock / whenReady）之前跑，据 argv + 显示环境决定：
 *  - version/help：CLI 查询，三平台通用，直接输出 + exit(0)，根本不触发 GUI 初始化。
 *  - headless：无图形环境正常启动（GUI app 需桌面），提示用户 + exit(1)，避免走到崩溃/segfault。
 *  - none：正常 GUI 启动，继续走原流程。
 */
export type CliEarlyExit = 'version' | 'help' | 'headless' | 'none';

/** 早退判定所需的环境变量子集（显示服务 + POSIX locale 来源）。process.env 结构兼容此类型。 */
export interface CliEnv {
  DISPLAY?: string;
  WAYLAND_DISPLAY?: string;
  LANGUAGE?: string;
  LC_ALL?: string;
  LC_MESSAGES?: string;
  LANG?: string;
}

export function resolveCliEarlyExit(
  argv: string[],
  env: CliEnv,
  platform: NodeJS.Platform
): CliEarlyExit {
  const has = (...flags: string[]): boolean => flags.some((f) => argv.includes(f));
  if (has('-V', '--version')) return 'version';
  if (has('-h', '--help')) return 'help';
  // 无图形环境正常启动：仅 Linux 用 DISPLAY/WAYLAND 判定（X11/Wayland 缺失=必崩）。macOS（WindowServer）/
  // Windows（桌面 session）通常有显示服务，且无等价的简单环境变量信号，本早退暂不覆盖（CLI flag 早退仍三平台通用）。
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return 'headless';
  return 'none';
}

/** -h/--help 的用法文本（CLI 通用英文，与 i18n 无关——CLI 帮助按惯例英文）。version 由调用方拼 app.getVersion()。 */
export function cliHelpText(version: string): string {
  return (
    `FlowZ ${version}\n\n` +
    `Usage: flowz [options]\n` +
    `  -V, --version   Show version and exit\n` +
    `  -h, --help      Show this help and exit\n`
  );
}

/** POSIX locale（lang_TERRITORY.codeset@modifier）→ BCP47 子串（剥 .codeset/@modifier、`_`→`-`，滤 C/POSIX）；无效返 null。 */
function normalizePosixLocale(loc: string): string | null {
  const base = loc.trim().split('.')[0].split('@')[0].trim();
  if (!base) return null;
  const upper = base.toUpperCase();
  if (upper === 'C' || upper === 'POSIX') return null;
  return base.replace(/_/g, '-');
}

/**
 * 从环境变量解析系统语言优先级列表（headless 早退在 app ready 前，app.getPreferredSystemLanguages 不可用时的来源）。
 * GNU gettext 优先级：LANGUAGE（冒号分隔的优先级列表）> LC_ALL > LC_MESSAGES > LANG。喂 resolveAutoLanguage 逐个匹配。
 * 比单一 Intl 主 locale 更全：主语言不受支持但次选受支持时仍能命中（与 normal 路径用完整有序列表一致）。
 * C-override（GNU 真实语义）：messages category（LC_ALL>LC_MESSAGES>LANG）为 C/POSIX 时用户显式要英文，LANGUAGE 整体忽略。
 */
export function systemLanguagesFromEnv(env: CliEnv): string[] {
  const out: string[] = [];
  const add = (raw: string | undefined, isList: boolean): void => {
    if (!raw) return;
    for (const part of isList ? raw.split(':') : [raw]) {
      const norm = normalizePosixLocale(part);
      if (norm) out.push(norm);
    }
  };
  // messages locale 为 C/POSIX（normalizePosixLocale 对其及空值返 null）→ 忽略 LANGUAGE，落 en-US fallback。
  const messages = env.LC_ALL || env.LC_MESSAGES || env.LANG;
  const messagesIsC = !!messages && normalizePosixLocale(messages) === null;
  if (!messagesIsC) add(env.LANGUAGE, true);
  add(env.LC_ALL, false);
  add(env.LC_MESSAGES, false);
  add(env.LANG, false);
  return out;
}

/** 早退编排的 IO 边界（index.ts 注入真实实现；单测注入 spy 验证编排，绕开 index 顶层块 import 期不可测）。 */
export interface CliEarlyExitIo {
  readonly argv: string[];
  readonly env: CliEnv;
  readonly platform: NodeJS.Platform;
  getVersion(): string;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  /** 据系统语言列表设定主进程语言（index 实现：setMainLanguage(resolveAutoLanguage(langs))）。 */
  setLanguage(langs: string[]): void;
  /** 取已设定语言下的 headless 提示文案（index 实现：mt('headlessNoDisplay')，须在 setLanguage 之后调用）。 */
  headlessMessage(): string;
  exit(code: number): void;
}

/**
 * CLI / 非 GUI 早退编排。命中 version/help/headless 则输出 + exit 并返 true；none 返 false（继续 GUI 启动）。
 * 调用方 exit 实现须同步终止（process.exit），返回值仅供单测/防御——理论上 exit 后不再返回。
 */
export function runCliEarlyExit(io: CliEarlyExitIo): boolean {
  const kind = resolveCliEarlyExit(io.argv, io.env, io.platform);
  switch (kind) {
    case 'version':
      io.writeStdout(`FlowZ ${io.getVersion()}\n`);
      io.exit(0);
      return true;
    case 'help':
      io.writeStdout(cliHelpText(io.getVersion()));
      io.exit(0);
      return true;
    case 'headless':
      io.setLanguage(systemLanguagesFromEnv(io.env));
      io.writeStderr(`${io.headlessMessage()}\n`);
      io.exit(1);
      return true;
    default:
      return false;
  }
}
