import { defineConfig } from 'vitest/config';

// Vitest はデータ / 収集パーサ / エンジンの検証のみを担う（Node 環境）。
// ブラウザ実行時の検証（D1, F1-F6）は Playwright 側 = scripts/ui-check.sh。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // state/ 配下にはビルド用 worktree が残ることがあるため必ず除外する。
    exclude: ['node_modules/**', 'dist/**', 'state/**', 'coverage/**', 'e2e/**'],
  },
});
