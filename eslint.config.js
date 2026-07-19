import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

import local from './eslint-rules/index.js';

/** E4: 禁止語リストは設定ファイルに外出しする（ACCEPTANCE の指定）。 */
const forbiddenTerms = JSON.parse(
  readFileSync(fileURLToPath(new URL('./config/forbidden-terms.json', import.meta.url)), 'utf8'),
).terms;

/** 意図的な未使用は `_` 接頭辞で示す。この規約はテスト側でも守る。 */
const unusedVars = [
  'error',
  {
    args: 'after-used',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrors: 'all',
    caughtErrorsIgnorePattern: '^_',
    destructuredArrayIgnorePattern: '^_',
  },
];

export default tseslint.config(
  {
    // ランタイム / ビルド生成物は決して lint しない。
    // 特に state/ にはビルド用の worktree が残るため、除外しないと
    // 他フィーチャの中間状態を lint してリペアループが自分では直せない
    // 失敗を叩き続けることになる。
    ignores: [
      'node_modules/**',
      'dist/**',
      'state/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'blob-report/**',
      'data/raw/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    plugins: { local },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': unusedVars,
    },
  },

  // ---- React / UI レイヤ ----
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'jsx-a11y': jsxA11y, 'react-hooks': reactHooks },
    rules: {
      // E3: jsx-a11y recommended をエラー 0 で通す。
      ...jsxA11y.flatConfigs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // E2: 色はデザイントークン経由のみ。TS/TSX では色リテラルを一切書かない。
      'local/no-literal-color': 'error',
    },
  },

  // ---- E1: 絵文字禁止 ----
  {
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.{js,mjs,ts}', 'tests/**/*.ts', 'e2e/**/*.ts'],
    rules: { 'local/no-emoji': 'error' },
  },

  // ---- E4: 禁止語 ----
  {
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.{js,mjs}', 'tests/**/*.ts', 'e2e/**/*.ts'],
    rules: { 'local/no-forbidden-terms': ['error', { terms: forbiddenTerms }] },
  },

  // ---- 収集スクリプトは Node 専用 ----
  {
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
);
