/**
 * #350 节点协议表单的「提交按钮接线」门。
 *
 * 架构事实（本门的前提，第 2 组断言把它钉住）：协议表单组件（`*-form.tsx`）渲染 `<form id="node-cfg-form">`
 * 但**自身一个提交按钮都没有**——按钮靠 HTML 的 `form=` 属性从表单外面跨节点绑进来。
 *
 * 这曾是一条**不可见、无类型、无强制**的宿主义务：「挂了协议表单，你就得在某处渲染一个绑到它的提交按钮」。
 * tsc 查不出、渲染不报错，三个宿主漏了两个（组网 WireGuard 无添加按钮 = #350；Tailscale 设置无保存按钮 =
 * 同款未被报告的姊妹腿）。根治办法是把义务从宿主手里收走：页脚改由 `NodeFormDialog` 外壳渲染。
 *
 * 故本门钉的是**根治后的结构**，而不是「每个宿主都记得加按钮」——后者只是把已漏的补上，义务原样留着：
 *  · 绑到协议表单的提交按钮，全仓**有且仅有一处**（外壳）；
 *  · 挂协议表单的宿主，**只能经外壳挂**。
 * 任一条被绕开都红。前者防「有人又在宿主里手搓一套按钮」，后者防「有人绕过外壳直接用 raw Dialog」。
 *
 * 为什么是源码级判据而不是挂载渲染：本仓 renderer 测试全为纯逻辑（`testEnvironment: 'node'`），
 * 无 jsdom / testing-library。为这一条引入整套 DOM 测试栈不划算；而本缺陷的判据恰好是纯文本可判的
 * 「谁挂了表单」×「谁绑了提交按钮」的对账，不依赖运行时。
 *
 * **已知射程边界（如实记，两条）**：
 *  · 文本级判据能证明宿主**引用了**外壳，不能证明表单**嵌在**外壳里面。要绕过得刻意在同一文件里
 *    既用外壳又把表单挂到外壳外——比原来的「忘了加按钮」难得多，接受该残余。
 *  · **`hideFooter` 是一条本门读不到的逃生口**（比上一条便宜得多，故单列）：在挂着协议表单的宿主上
 *    加这一个 token，页脚就没了、#350 原样长回来，而四条断言无一读它（实测：给 Tailscale 设置弹窗
 *    加 `hideFooter` → 保存按钮消失、门 4 passed 全绿）。与原缺陷的差别是 omission 变 commission：
 *    默认 `false` 安全，要复发得主动写一个紧邻 JSDoc 明令禁止的 prop。真正按构造关掉它得拆成
 *    「恒有页脚的 NodeFormDialog」+「无页脚的面板弹窗」两个组件——见 PR 讨论，未做。
 */
import * as fs from 'fs';
import * as path from 'path';

const RENDERER = path.resolve(__dirname, '../../..');
const SHELL = 'components/settings/node-form-dialog.tsx';

/** 递归收集 renderer 下全部 .tsx（跳过 __tests__ 自身）。 */
function allTsx(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__' && e.name !== 'node_modules') allTsx(p, out);
    } else if (e.name.endsWith('.tsx')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * **先剥注释再判**（块注释含 JSX 的 `{/* … *\/}`，行注释含 `//`）。
 *
 * 判据自污染实录（踩过三次，全部实测复现）：
 *  ① 本门与外壳的注释里都逐字写了 `<form id="node-cfg-form">` 来说明机制 —— 不剥块注释就会把
 *     「解释这条规则的注释」当成「遵守这条规则的代码」，宿主被误判成表单、判据整体空转。
 *  ② 只剥块注释不够：绕过外壳的宿主里加一行 `// TODO: 后续迁到 <NodeFormDialog` 就能让第 ④ 条判它合规。
 *     「行内 `//` 不剥，因为 URL 里的 `//` 会误伤」只对「剥到行尾」的粗暴实现成立 —— 下面这个扫描器
 *     跳过字符串/模板字面量，URL 在引号里，不受影响。
 *  ③ 正则式剥法会被**字面量里的 `/*`** 劫持：`'vless://u@h?x=1#/*'` 之后直到下一个 `*\/` 的真实代码全被吞掉。
 *     最阴的一腿是毒到真表单文件上 —— `formFiles` 从 14 静默降到 13，而下界只是 `>= 10`，余量把这次
 *     丢失完全吸收，四条断言仍全绿，此后该表单的宿主不受任何约束。
 *
 * 故改用逐字符扫描：识别字符串/模板字面量并原样保留，其外的 `//` 与 `/* *\/` 一律剥掉。
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        i += 1;
      }
      out += src[i] ?? '';
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const FILES = allTsx(RENDERER).map((p) => ({
  path: p,
  rel: path.relative(RENDERER, p).split(path.sep).join('/'),
  src: stripComments(fs.readFileSync(p, 'utf8')),
}));

/** 判「该文件渲染了 <form id="node-cfg-form">」——限定在 `<form` 标签内。 */
const FORM_TAG_RE = /<form[^>]*\bid="node-cfg-form"/;
/** 判「该文件把按钮绑到了协议表单」：字面量或外壳导出的常量，两种写法都算。 */
const BINDING_RE = /form=(?:"node-cfg-form"|\{NODE_FORM_ID\})/;
/**
 * 单个 `<button …>` 开标签。**必须按标签切分再判**，不能在整份文件上做
 * 「有 `type="submit"` ∧ 有 `form=` 绑定」的合取 —— 那样只删提交按钮的绑定、留着 reset 的，
 * 左项由 reset 顶上，四条断言全绿（实测），而那恰是 #350 的原始形态：按钮在、绑定没了，
 * 点下去零反应（协议表单自身 `type="submit"` 计数为 0，无隐式提交兜底）。
 * `[^>{]|\{[^}]*\}` 而非 `[^>]*`：JSX 属性里的箭头函数含 `>`（`onClick={() => f(false)}`），
 * 用后者会在箭头处截断，属性顺序一变就静默漏判。
 */
const BUTTON_TAG_RE = /<button\b(?:[^>{]|\{[^}]*\})*>/g;
/** 组件导出名：宿主是以 `<XxxForm` 的形式引用它的。 */
const EXPORTED_RE = /export\s+function\s+(\w+)/g;

const formFiles = FILES.filter((f) => FORM_TAG_RE.test(f.src));
/** 自身不带提交按钮的那批——只有它们的宿主受本门约束。自带按钮的面板（WARP/custom）不适用。 */
const externallySubmitted = formFiles.filter((f) => !f.src.includes('type="submit"'));

const componentNames = (f: { src: string }): string[] =>
  [...f.src.matchAll(EXPORTED_RE)].map((m) => m[1]).filter((n) => /Form$/.test(n));

const formNames = new Set(externallySubmitted.flatMap(componentNames));
const formPaths = new Set(externallySubmitted.map((f) => f.path));
/** 宿主 = 引用了这批表单组件的非表单文件。 */
const hosts = FILES.filter(
  (f) => !formPaths.has(f.path) && [...formNames].some((n) => f.src.includes(`<${n}`))
);

describe('#350 协议表单的提交按钮接线', () => {
  it('反平凡：确实存在一批渲染 <form id="node-cfg-form"> 的协议表单，且都能被反查到组件名', () => {
    expect(formFiles.length).toBeGreaterThanOrEqual(10);
    for (const f of formFiles) {
      expect({ file: f.rel, names: componentNames(f) }).toEqual({
        file: f.rel,
        names: expect.arrayContaining([expect.any(String)]),
      });
    }
    // 名字集为空会让下面两条恒绿
    expect(formNames.size).toBeGreaterThanOrEqual(10);
  });

  it('前提：这批表单自身不提供提交按钮（按钮一律从表单外面经 form= 绑进来）', () => {
    // 若某天某个表单改成自带按钮，本条会红——那是提醒「本门的前提变了，需重新推导」，不是误报：
    // externallySubmitted 会自动把它排除，宿主要求随之放宽，判据不会因此变松而无声。
    expect(externallySubmitted.map((f) => f.rel).sort()).toEqual(
      formFiles.map((f) => f.rel).sort()
    );
  });

  it('绑到协议表单的提交按钮全仓有且仅有一处：NodeFormDialog 外壳', () => {
    // 合取必须落在**同一个 button 标签**内（理由见 BUTTON_TAG_RE）。
    const binders = FILES.filter((f) =>
      [...f.src.matchAll(BUTTON_TAG_RE)].some(
        (m) => /type="submit"/.test(m[0]) && BINDING_RE.test(m[0])
      )
    )
      .map((f) => f.rel)
      .sort();
    // 多一处 = 有人又在宿主里手搓了一套；零处 = 外壳的页脚被删了，或提交按钮丢了绑定。三种都红。
    expect(binders).toEqual([SHELL]);
  });

  it('挂了协议表单的宿主只能经 NodeFormDialog 外壳挂', () => {
    // 反平凡：至少 server-config-dialog + 两个组网入口。宿主集为空会让断言恒绿。
    expect(hosts.length).toBeGreaterThanOrEqual(3);
    const bypassing = hosts.filter((f) => !f.src.includes('<NodeFormDialog')).map((f) => f.rel);
    expect(bypassing).toEqual([]);
  });
});
