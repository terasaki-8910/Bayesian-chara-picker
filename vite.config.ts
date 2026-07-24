import { appendFileSync, mkdirSync } from 'node:fs';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * ローカル開発中だけ、セッションログを `state/session-logs/log.jsonl` に
 * 1行1レコードで追記するミドルウェア。`npm run dev`（Vite の開発サーバ）
 * でのみ有効（`configureServer` は本番ビルドには一切含まれない）。
 * `npm run build` の成果物にはこのエンドポイント自体が存在しない ——
 * D1（外部ホストへの実行時ネットワークリクエスト0件）はビルド後の dist を
 * Playwright で検証するものなので影響しない。GitHub Pages 等の静的ホストに
 * デプロイした後は、このエンドポイントへの POST は単に届かず失敗するだけ
 * （`src/hooks/useSessionLog.ts` 側で `import.meta.env.DEV` ガード済み）。
 */
function sessionLogDevPlugin(): Plugin {
  return {
    name: 'session-log-dev',
    apply: 'serve',
    configureServer(server) {
      mkdirSync('state/session-logs', { recursive: true });
      server.middlewares.use('/__session-log', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          try {
            const record: unknown = JSON.parse(body);
            appendFileSync('state/session-logs/log.jsonl', JSON.stringify(record) + '\n');
          } catch {
            // 壊れたレコードは無視する（開発中の補助ログであり、機能停止にはしない）。
          }
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

// 静的 SPA。実行時のネットワークアクセスはゼロ（D1）なので proxy 等は置かない。
// データ（data/*.json）はビルド時に同梱する。
export default defineConfig({
  plugins: [react(), tailwindcss(), sessionLogDevPlugin()],
  build: {
    outDir: 'dist',
    // D2 の文字列走査を意味のあるものにするため、ソースマップは出力しない
    // （元 HTML 断片がマップ経由で dist に混入するのを防ぐ）。
    sourcemap: false,
  },
});
