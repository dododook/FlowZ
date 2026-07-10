// @ts-check
/**
 * 构建期国旗资产 generator（离线一次性；产物 committed，jest/CI/package 不需跑）。
 *
 * 读 flag-regions.json 的 code 列表 → 逐个读 node_modules/country-flag-icons/3x2/<CODE>.svg
 * → 严格校验（viewBox 存在、宽高比 1.5±0.01、无 id=/<style>/href/url(，任一不满足即 fail）
 * → 根标签规范化为 `<svg viewBox="<原值>" width="30" height="20">`（strip xmlns，父级 flagSvg 已有）
 * → JSON.stringify 转义 → 写 flag-assets.generated.ts（FLAG_BODIES: Record<code, rawSvg>）。
 *
 * 波浪包装（圆角/波光/双波纹/边框）是运行期 flagSvg 的单一真值，本脚本只吐「未包装的原始旗面串」。
 * 库旗面 3:2 与 viewBox 30×20 同比例，嵌套 <svg> 自建坐标系自动缩放，零裁切零坐标改写。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { format, resolveConfig } from 'prettier';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SETTINGS_DIR = join(ROOT, 'src/renderer/components/settings');
const FLAG_DIR = join(ROOT, 'node_modules/country-flag-icons/3x2');
const PKG = join(ROOT, 'node_modules/country-flag-icons/package.json');

const ASPECT = 1.5;
const TOL = 0.01;
const FORBIDDEN = ['id=', '<style', 'href', 'url('];

const manifest = JSON.parse(readFileSync(join(SETTINGS_DIR, 'flag-regions.json'), 'utf8'));
const pkgVersion = JSON.parse(readFileSync(PKG, 'utf8')).version;

/** @type {Record<string, string>} */
const bodies = {};
/** @type {string[]} */
const errors = [];

for (const region of manifest) {
  const code = String(region.code);
  const upper = code.toUpperCase();
  const file = join(FLAG_DIR, `${upper}.svg`);

  let raw;
  try {
    raw = readFileSync(file, 'utf8').trim();
  } catch {
    errors.push(`${code}: 缺文件 3x2/${upper}.svg（country-flag-icons 未收录该 code）`);
    continue;
  }

  for (const bad of FORBIDDEN) {
    if (raw.includes(bad)) errors.push(`${code}: 含禁用构造 '${bad}'（id 冲突/CSP 风险）`);
  }

  const open = raw.match(/^<svg\b[^>]*>/);
  if (!open) {
    errors.push(`${code}: 未找到 <svg> 根标签`);
    continue;
  }
  const vbMatch = open[0].match(/viewBox="([^"]*)"/);
  if (!vbMatch) {
    errors.push(`${code}: 根标签缺 viewBox`);
    continue;
  }
  const viewBox = vbMatch[1].trim();
  const nums = viewBox.split(/\s+/).map(Number);
  if (nums.length !== 4 || nums.some((n) => Number.isNaN(n))) {
    errors.push(`${code}: viewBox 非法 '${viewBox}'`);
    continue;
  }
  const [, , w, h] = nums;
  const aspect = w / h;
  if (Math.abs(aspect - ASPECT) > TOL) {
    errors.push(`${code}: 宽高比 ${aspect.toFixed(4)} 偏离 1.5（viewBox '${viewBox}'），非 3:2`);
  }

  const close = raw.lastIndexOf('</svg>');
  if (close < 0) {
    errors.push(`${code}: 未找到 </svg> 收尾`);
    continue;
  }
  const inner = raw.slice(open[0].length, close);
  // 规范化根标签：保留原 viewBox（含偏移式），strip xmlns，固定 30×20 供 flagSvg 嵌套。
  bodies[code] = `<svg viewBox="${viewBox}" width="30" height="20">${inner}</svg>`;
}

if (errors.length) {
  console.error('gen-flag-assets 失败（严格校验未通过）：');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const entries = manifest
  .map((r) => `  ${JSON.stringify(r.code)}: ${JSON.stringify(bodies[r.code])},`)
  .join('\n');

const source = `// 旗面 SVG 含固定国家色（非主题 token）；hex 属预期，非样式硬编码（no-restricted-syntax 不匹配串内 hex，无需 disable）。
// ⚠️ AUTO-GENERATED —— 由 scripts/gen-flag-assets.mjs 生成，请勿手改。
// 数据源：country-flag-icons@${pkgVersion}（MIT License, © catamphetamine）。
// 重新生成：npm run gen:flags
// 内容为「未包装的原始旗面 SVG 串」；波浪包装单一真值在运行期 flag-assets.ts 的 flagSvg。
export const FLAG_BODIES: Record<string, string> = {
${entries}
};
`;

const outFile = join(SETTINGS_DIR, 'flag-assets.generated.ts');
// 用项目自身 prettier 配置格式化，保证 committed 产物零 prettier 警告且确定性（可复现 freshness gate）。
const prettierConfig = (await resolveConfig(outFile)) ?? {};
const out = await format(source, { ...prettierConfig, parser: 'typescript' });

writeFileSync(outFile, out);
console.log(`生成 ${Object.keys(bodies).length} 面旗（country-flag-icons@${pkgVersion}）→ flag-assets.generated.ts`);
