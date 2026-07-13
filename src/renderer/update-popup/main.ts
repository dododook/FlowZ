/**
 * update-popup/main.ts — 独立更新弹窗的 vanilla 状态机（无 React runtime，90px 高瞬态窗不值引 React）。
 *
 * 与主窗共享 index.css/conduit.css/fonts.css（同一 Conduit token/组件类/@font-face，单一真值零复制）。
 * 主进程经 preload 暴露的 window.flowzUpdatePopup.onState 推四态载荷；按钮/关闭经 sendAction 回传。
 */
import '../assets/fonts/fonts.css';
import '../index.css';
import '../conduit.css';
import './popup.css';
import type { UpdatePopupState, UpdatePopupAction } from '../../shared/types/update';

declare global {
  interface Window {
    flowzUpdatePopup?: {
      onState(cb: (state: UpdatePopupState) => void): () => void;
      sendAction(action: UpdatePopupAction): void;
    };
  }
}

// 图标（静态、受信；下载=AppUpdateBanner 同款、勾/叹号/×）。
const ICON_DOWN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 3v11M8 10l4 4 4-4M5 20h14" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_OK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12.5l4.5 4.5L19 7.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_ERR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 7v6M12 16.6v.4" stroke-linecap="round"/></svg>';
const ICON_X =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>';

const root = document.getElementById('update-root');
let current: UpdatePopupState | null = null;
// 入场动画只播一次：仅首个全量 render 给 .upop 加 .enter（相变重建的 .upop 不带 → 不重播）。
let firstRender = true;

/** HTML 转义：version/notes/errorText 可能含 GitHub 侧内容，注入 innerHTML 前一律转义（防 XSS）。 */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  );
}

function send(action: UpdatePopupAction): void {
  window.flowzUpdatePopup?.sendAction(action);
}

function render(s: UpdatePopupState): void {
  if (!root) return;
  const prevPhase = current?.phase;
  current = s;
  // 主题：以载荷 theme 为准（nativeTheme 生效值），首帧即对；matchMedia 变化再实时联动（见下）。
  document.documentElement.classList.toggle('dark', s.theme === 'dark');

  // progress→progress（下载中逐 chunk 更新）：原地 patch 宽度/字节/百分比，不重建 DOM——否则 .bar 的
  // width .3s 过渡与 sheen 动画每帧被替换重置（进度条跳变、shimmer 不可见）+ 白费重挂 listener。
  if (s.phase === 'progress' && prevPhase === 'progress') {
    const pct = Math.max(0, Math.min(100, Math.round(s.percentage ?? 0)));
    const fill = root.querySelector<HTMLElement>('.bar > i');
    const bytes = root.querySelector<HTMLElement>('.upop-bytes');
    const pctEl = root.querySelector<HTMLElement>('.upop-pct');
    if (fill && bytes && pctEl) {
      fill.style.width = `${pct}%`;
      bytes.textContent = s.mirror ? s.labels.tryingMirror : (s.bytesText ?? '');
      pctEl.textContent = `${pct}%`;
      return;
    }
    // 缺元素（异常）→ 落到全量重建兜底。
  }

  const L = s.labels;
  const pill = `<span class="pill proto">${esc(s.version)}</span>`;
  let body = '';

  if (s.phase === 'remind') {
    body = `
      <div class="upop-hd">
        <span class="upop-chip">${ICON_DOWN}</span>
        <span class="upop-title">${esc(L.remindTitle)}</span>
        ${pill}
        <button class="upop-x" type="button" data-act="later" aria-label="${esc(L.later)}">${ICON_X}</button>
      </div>
      ${s.currentVersion ? `<div class="upop-sub">${esc(L.currentPrefix)} ${esc(s.currentVersion)}</div>` : ''}
      ${s.notes ? `<div class="upop-notes">${esc(s.notes)}</div>` : ''}
      <div class="upop-acts">
        <button class="btn flow sm" type="button" data-act="update">${esc(L.update)}</button>
        <button class="btn ghost sm" type="button" data-act="later">${esc(L.later)}</button>
      </div>
      <div class="upop-links">
        <button type="button" data-act="skip">${esc(L.skip)}</button>
        <button type="button" data-act="viewLog">${esc(L.viewLog)}</button>
      </div>`;
  } else if (s.phase === 'progress') {
    const pct = Math.max(0, Math.min(100, Math.round(s.percentage ?? 0)));
    body = `
      <div class="upop-hd">
        <span class="upop-chip">${ICON_DOWN}</span>
        <span class="upop-title">${esc(L.progressTitle)}</span>
        ${pill}
        <button class="upop-x" type="button" data-act="cancel" aria-label="${esc(L.cancel)}" title="${esc(L.cancel)}">${ICON_X}</button>
      </div>
      <div class="bar"><i class="dl" style="width:${pct}%"></i></div>
      <div class="upop-meta">
        <span class="upop-bytes">${esc(s.mirror ? L.tryingMirror : (s.bytesText ?? ''))}</span>
        <span class="upop-pct">${pct}%</span>
      </div>`;
  } else if (s.phase === 'done') {
    body = `
      <div class="upop-hd">
        <span class="upop-chip ok">${ICON_OK}</span>
        <span class="upop-title">${esc(L.doneTitle)}</span>
        ${pill}
      </div>
      <div class="bar"><i class="ok" style="width:100%"></i></div>
      <div class="upop-meta">
        <span class="upop-bytes">${esc(L.installing)}</span>
        <span class="upop-pct ok">100%</span>
      </div>`;
  } else {
    body = `
      <div class="upop-hd">
        <span class="upop-chip err">${ICON_ERR}</span>
        <span class="upop-title">${esc(L.errorTitle)}</span>
        ${pill}
        <button class="upop-x" type="button" data-act="close" aria-label="${esc(L.close)}">${ICON_X}</button>
      </div>
      ${s.errorText ? `<div class="upop-err">${esc(s.errorText)}</div>` : ''}
      <div class="upop-acts">
        <button class="btn flow sm" type="button" data-act="retry">${esc(L.retry)}</button>
        <button class="btn ghost sm" type="button" data-act="manualDownload">${esc(L.manualDownload)}</button>
        <button class="btn ghost sm" type="button" data-act="close">${esc(L.close)}</button>
      </div>`;
  }

  root.innerHTML = `<div class="upop${firstRender ? ' enter' : ''}" data-phase="${s.phase}">${body}</div>`;
  firstRender = false;
  root.querySelectorAll<HTMLElement>('[data-act]').forEach((el) => {
    el.addEventListener('click', () => send(el.dataset.act as UpdatePopupAction));
  });
}

// 主题实时联动：主进程改 themeSource → prefers-color-scheme 变 → 重设 .dark（仅在已有状态时）。
const mq = window.matchMedia('(prefers-color-scheme: dark)');
mq.addEventListener('change', () => {
  if (current) document.documentElement.classList.toggle('dark', mq.matches);
});

// ESC：remind → later（稍后）/ progress → cancel（取消下载）/ error → close（关闭）；done 忽略（瞬态自动关）。
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !current) return;
  if (current.phase === 'remind') send('later');
  else if (current.phase === 'progress') send('cancel');
  else if (current.phase === 'error') send('close');
});

window.flowzUpdatePopup?.onState(render);
