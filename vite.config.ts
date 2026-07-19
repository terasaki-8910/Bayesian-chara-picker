import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 静的 SPA。実行時のネットワークアクセスはゼロ（D1）なので proxy 等は置かない。
// データ（data/*.json）はビルド時に同梱する。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    // D2 の文字列走査を意味のあるものにするため、ソースマップは出力しない
    // （元 HTML 断片がマップ経由で dist に混入するのを防ぐ）。
    sourcemap: false,
  },
});
