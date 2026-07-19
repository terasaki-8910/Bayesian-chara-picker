#!/usr/bin/env sh
# UI / E2E ゲート。scripts/gates.sh の gate_ui() から呼ばれる。
# ここでしか担保されない基準: D1（実行時ネットワーク 0）, D2（成果物への混入）,
# F1-F6（レスポンシブ / axe / キーボード操作 / モーダル / 年齢確認 / フォーカス可視）。
set -eu

echo "ui-check: ビルド (tsc --noEmit + vite build)"
npm run build

echo "ui-check: D2 ビルド成果物の走査"
node scripts/dist-scan.mjs dist

echo "ui-check: Playwright の実行ブラウザを確認"
# 取得済みなら no-op で終わる。未取得かつオフラインならここで明示的に落とす。
if ! npx playwright install chromium; then
  echo "ui-check: chromium を用意できません。ネットワーク接続を確認してください。" >&2
  exit 1
fi

echo "ui-check: D1 / F1-F6"
npx playwright test

echo "ui-check: OK"
