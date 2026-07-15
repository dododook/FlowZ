/**
 * 主窗终局兜底的**零依赖静态错误页**（GAP-1a 二次超时 / GAP-3 二次加载失败共用）。
 *
 * 为什么必须零依赖：本页在「renderer 的 React/i18n/theme bundle 已证实起不来」时加载，故不能依赖任何应用脚本、
 * 外链资源或主题 CSS——纯内联样式 + 一个 `location.reload()` 按钮，保证「无论 bundle 多坏，用户都能看到反馈 +
 * 一键重载」，而不是对着纯背景色空窗。文案双语（中/英）硬编码：i18n 本身可能正是坏的那一环，故不走 i18n。
 *
 * 纯函数、无 electron 依赖，全可单测；loadURL 的副作用留在 index.ts 接线层。
 */

export interface FatalErrorPageText {
  /** 标题（如「FlowZ 启动失败 / Failed to start」）。 */
  title: string;
  message: string;
  reloadLabel: string;
  /**
   * 重试 IPC 通道名（如 'fatal:retry'）。本页经 loadURL(data:) 加载（opaque origin），webSecurity 下自身
   * location.reload 只会空转重渲本错误页、恢复不了应用——故按钮改经 preload 的 ipcRenderer.invoke 调此通道，
   * 由主进程驱动 loadFile 重载真实应用（主进程导航不受 data: 顶层导航拦截）。preload 若不可用则回退 location.reload。
   * 缺省（未传）则纯 location.reload()（用于非 data: 场景 / 测试）。
   */
  retryChannel?: string;
}

/** HTML 转义：title/message 可能含错误描述文本，注入前一律转义防破坏结构。 */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  );
}

/**
 * 生成静态错误页 HTML。深底浅字（不依赖主题变量，深色兜底与主窗 backgroundColor #1F252E 同系，避免刺眼白闪）。
 * 重载按钮：有 retryChannel → 内联脚本经 preload invoke 通道请主进程重载真实应用（绕开 data: 导航拦截，真恢复），
 * 失败回退 location.reload()；无 retryChannel → 纯 location.reload()。data: 页无 CSP，内联脚本可执行。
 */
export function buildFatalErrorPageHtml(text: FatalErrorPageText): string {
  const title = esc(text.title);
  const message = esc(text.message);
  const reloadLabel = esc(text.reloadLabel);
  // 按钮接线：retryChannel 经 JSON.stringify 成安全 JS 字面量（主进程控制的常量，非用户输入）。
  const script = text.retryChannel
    ? `<script>document.getElementById('flowz-reload').addEventListener('click',function(){try{window.electron.ipcRenderer.invoke(${JSON.stringify(text.retryChannel)});}catch(e){location.reload();}});</script>`
    : `<script>document.getElementById('flowz-reload').addEventListener('click',function(){location.reload();});</script>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
html,body{margin:0;height:100%}
body{background:#1F252E;color:#E6EDF3;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box}
.box{max-width:520px}
h1{font-size:18px;font-weight:600;margin:0 0 12px}
p{font-size:13px;line-height:1.6;color:#9DA7B3;margin:0 0 20px;word-break:break-word}
button{font:inherit;font-size:13px;color:#fff;background:#2F81F7;border:0;border-radius:8px;padding:9px 20px;cursor:pointer}
button:hover{background:#2b76e0}
</style></head><body><div class="box"><h1>${title}</h1><p>${message}</p><button id="flowz-reload" type="button">${reloadLabel}</button></div>${script}</body></html>`;
}

/** 生成可直接 loadURL 的 data: URL（HTML 经 encodeURIComponent，兼容任意字符）。 */
export function fatalErrorPageDataUrl(text: FatalErrorPageText): string {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(buildFatalErrorPageHtml(text));
}
