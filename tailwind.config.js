/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: [
    "./src/renderer/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: ['IBM Plex Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        display: ['Space Grotesk', 'IBM Plex Sans', 'PingFang SC', 'sans-serif'],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        // 语义色（与 destructive 同模式）：供 badge/速率/告警/协议标识统一引用，明暗各一套
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
        // badge 色相（分类/协议标识）：需 /15 bg + /30 border 透明度 → 用 <alpha-value> 形式
        // （success/warning/info 为实心用、不带 alpha；此处带 alpha 是 badge 透明度的必需，非风格变体）。
        "badge-blue": "hsl(var(--badge-blue) / <alpha-value>)",
        "badge-purple": "hsl(var(--badge-purple) / <alpha-value>)",
        "badge-orange": "hsl(var(--badge-orange) / <alpha-value>)",
        "badge-cyan": "hsl(var(--badge-cyan) / <alpha-value>)",
        "badge-green": "hsl(var(--badge-green) / <alpha-value>)",
        "badge-teal": "hsl(var(--badge-teal) / <alpha-value>)",
        "badge-indigo": "hsl(var(--badge-indigo) / <alpha-value>)",
        "badge-rose": "hsl(var(--badge-rose) / <alpha-value>)",
        "badge-slate": "hsl(var(--badge-slate) / <alpha-value>)",
        "badge-sky": "hsl(var(--badge-sky) / <alpha-value>)",
        "badge-amber": "hsl(var(--badge-amber) / <alpha-value>)",
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: 0 },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: 0 },
        },
        "conduit-flow": {
          "0%": { left: "0%", opacity: "0" },
          "15%": { opacity: "1" },
          "85%": { opacity: "1" },
          "100%": { left: "100%", opacity: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "conduit-flow": "conduit-flow 2.4s linear infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
