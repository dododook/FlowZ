/* eslint-disable no-restricted-syntax -- Local SVG flag artwork needs fixed national colors, not theme tokens. */
export interface FlagAsset {
  code: string;
  label: string;
  src: string;
}

const flagSvg = (body: string): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20">${body}</svg>`
  )}`;

const h = (colors: string[]): string =>
  flagSvg(
    colors
      .map(
        (color, i) =>
          `<rect width="30" height="${20 / colors.length}" y="${(20 / colors.length) * i}" fill="${color}"/>`
      )
      .join('')
  );

const v = (colors: string[]): string =>
  flagSvg(
    colors
      .map(
        (color, i) =>
          `<rect width="${30 / colors.length}" height="20" x="${(30 / colors.length) * i}" fill="${color}"/>`
      )
      .join('')
  );

const flagDefinitions: Record<string, { label: string; src: string }> = {
  ar: {
    label: 'Argentina',
    src: flagSvg(
      '<rect width="30" height="20" fill="#74acdf"/><rect y="6.67" width="30" height="6.66" fill="#fff"/><circle cx="15" cy="10" r="1.6" fill="#f6b40e"/>'
    ),
  },
  au: {
    label: 'Australia',
    src: flagSvg(
      '<rect width="30" height="20" fill="#012169"/><path d="M2 2l10 6m0-6L2 8" stroke="#fff" stroke-width="2"/><path d="M2 2l10 6m0-6L2 8" stroke="#c8102e" stroke-width="1"/><path d="M7 1v8M1 5h12" stroke="#fff" stroke-width="3"/><path d="M7 1v8M1 5h12" stroke="#c8102e" stroke-width="1.4"/><circle cx="22" cy="6" r="1.2" fill="#fff"/><circle cx="18" cy="12" r="1.2" fill="#fff"/><circle cx="25" cy="14" r="1.2" fill="#fff"/>'
    ),
  },
  br: {
    label: 'Brazil',
    src: flagSvg(
      '<rect width="30" height="20" fill="#009b3a"/><path d="M15 3l11 7-11 7-11-7z" fill="#ffdf00"/><circle cx="15" cy="10" r="4.2" fill="#002776"/><path d="M11 9.2c3.3-.7 6.1-.4 8.5 1" stroke="#fff" stroke-width="1" fill="none"/>'
    ),
  },
  ca: {
    label: 'Canada',
    src: flagSvg(
      '<rect width="7.5" height="20" fill="#d52b1e"/><rect x="7.5" width="15" height="20" fill="#fff"/><rect x="22.5" width="7.5" height="20" fill="#d52b1e"/><path d="M15 4l1.2 3 2.5-1-1 3 2.8.7-2.6 1.5 1.5 2.6-3-.7-.4 3h-2l-.4-3-3 .7 1.5-2.6-2.6-1.5 2.8-.7-1-3 2.5 1z" fill="#d52b1e"/>'
    ),
  },
  ch: {
    label: 'Switzerland',
    src: flagSvg(
      '<rect width="30" height="20" fill="#d52b1e"/><rect x="13" y="4" width="4" height="12" fill="#fff"/><rect x="9" y="8" width="12" height="4" fill="#fff"/>'
    ),
  },
  de: { label: 'Germany', src: h(['#000', '#dd0000', '#ffce00']) },
  es: {
    label: 'Spain',
    src: flagSvg(
      '<rect width="30" height="20" fill="#aa151b"/><rect y="5" width="30" height="10" fill="#f1bf00"/>'
    ),
  },
  fr: { label: 'France', src: v(['#0055a4', '#fff', '#ef4135']) },
  gb: {
    label: 'United Kingdom',
    src: flagSvg(
      '<rect width="30" height="20" fill="#012169"/><path d="M0 0l30 20M30 0L0 20" stroke="#fff" stroke-width="4"/><path d="M0 0l30 20M30 0L0 20" stroke="#c8102e" stroke-width="2"/><path d="M15 0v20M0 10h30" stroke="#fff" stroke-width="6"/><path d="M15 0v20M0 10h30" stroke="#c8102e" stroke-width="3"/>'
    ),
  },
  hk: {
    label: 'Hong Kong',
    src: flagSvg(
      '<rect width="30" height="20" fill="#de2910"/><g fill="#fff" transform="translate(15 10)"><ellipse rx="1.4" ry="4" transform="rotate(0) translate(0 -4)"/><ellipse rx="1.4" ry="4" transform="rotate(72) translate(0 -4)"/><ellipse rx="1.4" ry="4" transform="rotate(144) translate(0 -4)"/><ellipse rx="1.4" ry="4" transform="rotate(216) translate(0 -4)"/><ellipse rx="1.4" ry="4" transform="rotate(288) translate(0 -4)"/></g>'
    ),
  },
  id: { label: 'Indonesia', src: h(['#ce1126', '#fff']) },
  in: {
    label: 'India',
    src: flagSvg(
      '<rect width="30" height="6.67" fill="#ff9933"/><rect y="6.67" width="30" height="6.66" fill="#fff"/><rect y="13.33" width="30" height="6.67" fill="#138808"/><circle cx="15" cy="10" r="2.1" fill="none" stroke="#000080" stroke-width=".8"/><circle cx="15" cy="10" r=".55" fill="#000080"/>'
    ),
  },
  it: { label: 'Italy', src: v(['#009246', '#fff', '#ce2b37']) },
  jp: {
    label: 'Japan',
    src: flagSvg(
      '<rect width="30" height="20" fill="#fff"/><circle cx="15" cy="10" r="5" fill="#bc002d"/>'
    ),
  },
  kr: {
    label: 'South Korea',
    src: flagSvg(
      '<rect width="30" height="20" fill="#fff"/><path d="M15 6a4 4 0 1 1 0 8 2 2 0 1 0 0-4 2 2 0 1 1 0-4z" fill="#c60c30"/><path d="M15 14a4 4 0 1 1 0-8 2 2 0 1 0 0 4 2 2 0 1 1 0 4z" fill="#003478"/><g stroke="#111" stroke-width=".9"><path d="M6 4l4 2M5 6l4 2M21 4l4-2M22 6l4-2M6 16l4-2M5 14l4-2M21 16l4 2M22 14l4 2"/></g>'
    ),
  },
  my: {
    label: 'Malaysia',
    src: flagSvg(
      '<rect width="30" height="20" fill="#fff"/><g fill="#cc0001"><rect y="0" width="30" height="1.54"/><rect y="3.08" width="30" height="1.54"/><rect y="6.16" width="30" height="1.54"/><rect y="9.24" width="30" height="1.54"/><rect y="12.32" width="30" height="1.54"/><rect y="15.4" width="30" height="1.54"/><rect y="18.48" width="30" height="1.54"/></g><rect width="15" height="10.8" fill="#010066"/><circle cx="6.4" cy="5.4" r="3" fill="#ffcc00"/><circle cx="7.4" cy="5.4" r="2.5" fill="#010066"/><path d="M11 3.5l.6 1.3 1.4.2-1 .9.2 1.4-1.2-.7-1.2.7.2-1.4-1-.9 1.4-.2z" fill="#ffcc00"/>'
    ),
  },
  nl: { label: 'Netherlands', src: h(['#ae1c28', '#fff', '#21468b']) },
  ru: { label: 'Russia', src: h(['#fff', '#0039a6', '#d52b1e']) },
  se: {
    label: 'Sweden',
    src: flagSvg(
      '<rect width="30" height="20" fill="#006aa7"/><rect x="8" width="3.5" height="20" fill="#fecc00"/><rect y="8" width="30" height="3.5" fill="#fecc00"/>'
    ),
  },
  sg: {
    label: 'Singapore',
    src: flagSvg(
      '<rect width="30" height="10" fill="#ef3340"/><rect y="10" width="30" height="10" fill="#fff"/><circle cx="7" cy="5" r="3.1" fill="#fff"/><circle cx="8.1" cy="5" r="2.6" fill="#ef3340"/><circle cx="12" cy="3.1" r=".7" fill="#fff"/><circle cx="10.8" cy="5" r=".7" fill="#fff"/><circle cx="12" cy="6.9" r=".7" fill="#fff"/>'
    ),
  },
  tr: {
    label: 'Turkey',
    src: flagSvg(
      '<rect width="30" height="20" fill="#e30a17"/><circle cx="12" cy="10" r="4.4" fill="#fff"/><circle cx="13.4" cy="10" r="3.5" fill="#e30a17"/><path d="M19 7.5l.8 1.7 1.9.2-1.4 1.3.3 1.9-1.6-.9-1.7.9.4-1.9-1.4-1.3 1.9-.2z" fill="#fff"/>'
    ),
  },
  tw: {
    label: 'Taiwan',
    src: flagSvg(
      '<rect width="30" height="20" fill="#fe0000"/><rect width="15" height="10" fill="#000095"/><circle cx="7.5" cy="5" r="2.8" fill="#fff"/><circle cx="7.5" cy="5" r="1.4" fill="#000095"/>'
    ),
  },
  us: {
    label: 'United States',
    src: flagSvg(
      '<rect width="30" height="20" fill="#fff"/><g fill="#b22234"><rect y="0" width="30" height="1.54"/><rect y="3.08" width="30" height="1.54"/><rect y="6.16" width="30" height="1.54"/><rect y="9.24" width="30" height="1.54"/><rect y="12.32" width="30" height="1.54"/><rect y="15.4" width="30" height="1.54"/><rect y="18.48" width="30" height="1.54"/></g><rect width="12.8" height="10.8" fill="#3c3b6e"/><g fill="#fff"><circle cx="2" cy="2" r=".45"/><circle cx="4.5" cy="2" r=".45"/><circle cx="7" cy="2" r=".45"/><circle cx="9.5" cy="2" r=".45"/><circle cx="3.2" cy="4.2" r=".45"/><circle cx="5.7" cy="4.2" r=".45"/><circle cx="8.2" cy="4.2" r=".45"/><circle cx="10.7" cy="4.2" r=".45"/><circle cx="2" cy="6.4" r=".45"/><circle cx="4.5" cy="6.4" r=".45"/><circle cx="7" cy="6.4" r=".45"/><circle cx="9.5" cy="6.4" r=".45"/></g>'
    ),
  },
};

export const countryCodeToFlagAsset = (code: string | null): FlagAsset | null => {
  const key = code?.toLowerCase();
  if (!key) return null;
  const asset = flagDefinitions[key];
  return asset ? { code: key, ...asset } : null;
};
