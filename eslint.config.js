const js = require('@eslint/js');
const typescript = require('@typescript-eslint/eslint-plugin');
const typescriptParser = require('@typescript-eslint/parser');
const prettier = require('eslint-plugin-prettier');
const reactHooks = require('eslint-plugin-react-hooks');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.node,
        ...globals.es2020,
      },
    },
    plugins: {
      '@typescript-eslint': typescript,
      prettier: prettier,
      'react-hooks': reactHooks,
    },
    rules: {
      ...typescript.configs.recommended.rules,
      'prettier/prettier': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-useless-escape': 'warn',
      'no-useless-catch': 'warn',
    },
  },
  {
    // 主进程文件允许使用 require()
    files: ['src/main/**/*.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // UI 防偏移:渲染层禁裸 hex 颜色字面量,一律走 Conduit token(className bg-/text-/fill-* 或 hsl(var(--x)))。
      // 色值真值只在 index.css 的 :root/.dark token 块;新色必须深/浅双主题都加;SVG 用 fill-*/style var,不写 hex。
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Literal[value=/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]',
          message:
            '禁裸 hex 颜色(UI 防偏移):改用 Conduit token——className 走 bg-primary/text-success/fill-primary 等,或 hsl(var(--xxx));色值定义只在 index.css token 块。确需 hex(如 Electron API/非颜色)请就地加 eslint-disable 并注明理由。',
        },
        {
          // UI 防偏移(护栏盲区根治):禁裸 Tailwind 灰阶 palette class(gray/zinc/slate/neutral/stone-50..950),
          // 必须带标准颜色功能前缀(text/bg/border/fill/... -灰阶-档)才命中,避免误伤散文字符串或 scrollbar-* 插件 class。
          // 灰阶档已有 Conduit 语义 token 等价物(text-muted-foreground / bg-muted / border-border 等),一律改走 token 随双主题。
          // 彩色档(amber 等警示色)暂不纳入:现存成体系 warning 用法待独立批次按语义 token 迁移,避免本规则大面积误报。
          selector:
            'Literal[value=/(^|[\\s:!])(text|bg|border|fill|stroke|ring|ring-offset|from|via|to|divide|outline|decoration|accent|caret|placeholder|shadow)-(gray|zinc|slate|neutral|stone)-(50|100|200|300|400|500|600|700|800|900|950)\\b/]',
          message:
            '禁裸 Tailwind 灰阶 class(UI 防偏移):改用 Conduit 语义 token——text-muted-foreground / text-foreground / bg-muted / border-border 等,随深浅双主题。色值真值只在 index.css token 块。确需(如第三方插件 class)请就地加 eslint-disable 并注明理由。',
        },
      ],
    },
  },
  {
    // 测试文件放宽规则
    files: ['src/**/__tests__/**/*.ts', 'src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-restricted-syntax': 'off', // 测试可断言 hex 输出,不受 UI 防偏移规则约束
    },
  },
  {
    ignores: ['dist/**', 'dist-package/**', 'node_modules/**', 'build/**'],
  },
];
