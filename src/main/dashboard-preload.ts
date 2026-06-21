/**
 * dashboard-preload.ts — sing-box 官方面板「内窗口一键直连」preload（dashboard #55）。
 *
 * 真机实证 + 面板源码（index-*.js）实证：bundled 面板从 localStorage 取后端、不读任何 URL 参数。故必须在面板 JS 读
 * localStorage 前把后端写好。preload 在页面脚本之前于**同源**（dashboard origin = api service 同源）执行，直接写
 * window.localStorage 即满足「读前已写」。
 *
 * 写两个键（覆盖面板各版本）：
 *  - `sing-box-dashboard.servers`：权威存储 {servers:[{id,name,url,secret}],activeId}（面板渲染/连接实际数据源）。
 *  - `sing-box-dashboard.server` ：旧版迁移键 扁平 {url,secret}（面板读一次即 removeItem 并入 servers 存储）兜底极旧版。
 *
 * payload 经 webPreferences.additionalArguments 以 `--flowz-dashboard-server=<json>` 传入（主进程构造，含运行期动态
 * 端口 + secret），结构 {servers:<对象>, legacy:<对象>}。此窗口是 FlowZ 自有受信内容（本地 127.0.0.1 面板），
 * contextIsolation 关、零 Node 暴露：本脚本只写 localStorage，不 expose 任何 API、不引 ipcRenderer。
 */

// 本文件经 tsconfig.main.json（lib=ES2020，无 DOM）编译，但运行在渲染/页面上下文。经 globalThis 取 localStorage 形状，
// 避免 `declare const window`（与 base tsconfig 的 DOM lib window 冲突）。运行时 globalThis 即页面 window，同源 localStorage 可写。
const ls = (
  globalThis as {
    localStorage?: {
      getItem(key: string): string | null;
      setItem(key: string, value: string): void;
    };
  }
).localStorage;

const ARG_PREFIX = '--flowz-dashboard-server=';

try {
  const arg = process.argv.find((a) => a.startsWith(ARG_PREFIX));
  if (arg && ls) {
    const payload = JSON.parse(arg.slice(ARG_PREFIX.length)) as {
      servers?: unknown;
      legacy?: unknown;
      language?: string;
    };
    // 权威存储键（面板实际数据源）+ 旧版迁移键兜底。各自 stringify（localStorage 值须为 string）。
    if (payload.servers) ls.setItem('sing-box-dashboard.servers', JSON.stringify(payload.servers));
    if (payload.legacy) ls.setItem('sing-box-dashboard.server', JSON.stringify(payload.legacy));
    // 面板语言：仅首开（用户未手选过）写入，对齐 FlowZ 语言——否则 Electron 窗口 navigator.languages=en 致中文系统显英文。
    // 已存在即跳过（不覆盖用户在面板里的手动选择）。值为面板合法码（en/zh-Hans/zh-Hant/fa/ru）。
    if (payload.language && !ls.getItem('sing-box-dashboard.language')) {
      ls.setItem('sing-box-dashboard.language', payload.language);
    }
  }
} catch {
  // 写失败（隐私/无痕策略禁 localStorage 等）不阻断面板加载：面板回落自身「添加后端」表单，用户可手填（复制按钮兜底）。
}
