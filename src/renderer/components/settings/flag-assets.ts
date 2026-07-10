// 波浪包装与地球兜底含固定国家/中性色（非主题 token）；下方 SVG 字面量的 hex 属预期，非样式硬编码。
import { FLAG_BODIES } from './flag-assets.generated';
import regions from './flag-regions.json';

export interface FlagAsset {
  code: string;
  label: string;
  src: string;
}

// 波浪风格包装：圆角裁切 + 斜向布纹波光高光 + 两道波纹涟漪，20 国统一继承。
// 只叠加低透明度 overlay，不裁切旗面内容，识别度全保留。
const flagSvg = (body: string): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20">` +
      `<defs>` +
      `<clipPath id="fc"><rect width="30" height="20" rx="2.6"/></clipPath>` +
      `<linearGradient id="fs" x1="0" y1="0" x2=".9" y2="1">` +
      `<stop offset="0" stop-color="#fff" stop-opacity=".24"/>` +
      `<stop offset=".42" stop-color="#fff" stop-opacity="0"/>` +
      `<stop offset=".6" stop-color="#000" stop-opacity="0"/>` +
      `<stop offset="1" stop-color="#000" stop-opacity=".16"/>` +
      `</linearGradient>` +
      `</defs>` +
      `<g clip-path="url(#fc)">` +
      body +
      `<path d="M0 6 Q7.5 3.4 15 6 T30 6" fill="none" stroke="#fff" stroke-opacity=".12" stroke-width="1.6"/>` +
      `<path d="M0 14 Q7.5 11.4 15 14 T30 14" fill="none" stroke="#000" stroke-opacity=".1" stroke-width="1.7"/>` +
      `<rect width="30" height="20" fill="url(#fs)"/>` +
      `<rect width="30" height="20" rx="2.6" fill="none" stroke="#000" stroke-opacity=".14" stroke-width=".7"/>` +
      `</g>` +
      `</svg>`
  )}`;

// 未识别地区兵底：中性地球水印（消灭静默空白），与国旗同套波浪包装保持一致。
export const FALLBACK_FLAG: FlagAsset = {
  code: '',
  label: 'Unknown',
  src: flagSvg(
    '<rect width="30" height="20" fill="#565d6b"/><g fill="none" stroke="#d5d9e0" stroke-width=".9"><circle cx="15" cy="10" r="6.2"/><ellipse cx="15" cy="10" rx="2.5" ry="6.2"/><path d="M8.9 10h12.2M9.6 6.4h10.8M9.6 13.6h10.8"/></g>'
  ),
};

// code → 显示 label（单一真值走 flag-regions.json manifest；与 FLAG_BODIES 同 74 集合）。
const LABELS = new Map<string, string>(
  (regions as { code: string; label: string }[]).map((r) => [r.code, r.label])
);

// 波浪包装懒缓存：首次访问某 code 才 flagSvg(FLAG_BODIES[code]) 并缓存整个 FlagAsset，
// 避免每 render 重跑 encodeURIComponent。波浪包装仍是运行期 flagSvg 单一真值（generated 只存 raw 旗面）。
const ASSET_CACHE = new Map<string, FlagAsset>();

export const countryCodeToFlagAsset = (code: string | null): FlagAsset | null => {
  const key = code?.toLowerCase();
  if (!key) return null;
  const cached = ASSET_CACHE.get(key);
  if (cached) return cached;
  const body = FLAG_BODIES[key];
  if (body === undefined) return null;
  const asset: FlagAsset = { code: key, label: LABELS.get(key) ?? key, src: flagSvg(body) };
  ASSET_CACHE.set(key, asset);
  return asset;
};
