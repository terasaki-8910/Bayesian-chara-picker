/**
 * D2: ビルド成果物に DLsite 由来の素材が混入していないことを検査する。
 *
 * 検出対象は「持ち出してはいけないもの」だけに絞る:
 *   - 作品 ID（RJ…）— 作品を特定できる情報。同梱しない。
 *   - 作品詳細 URL / サムネイル host — 画像・タイトルの経路。
 *   - 検索結果 HTML の構造マーカー — 生 HTML をそのまま同梱した痕跡。
 *
 * 検索結果ページへの外部リンク（/maniax/fsr/...）は SPEC 2.4 で仕様上必要なので
 * 検出対象に含めない。ここを雑に禁止すると正しい実装が落ちる。
 *
 * ライブラリとしても CLI としても使う:
 *   import { scanText } from './dist-scan.mjs'   （Vitest から走査ロジックを検証）
 *   node scripts/dist-scan.mjs [distDir]         （scripts/ui-check.sh から実行）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {object} Violation
 * @property {string} source   検出元（dist からの相対パス、または `<text>`）
 * @property {string} patternId パターン識別子
 * @property {string} label     日本語のラベル
 * @property {string} sample    実際に一致した文字列
 * @property {number} index     一致位置
 */

/** 混入を検出するパターン表。 */
export const FORBIDDEN_PATTERNS = [
  { id: 'work-id', label: '作品 ID', re: /RJ\d{6,}/g },
  { id: 'work-detail-url', label: '作品詳細 URL', re: /\/work\/=\/product_id\//g },
  { id: 'thumbnail-host', label: 'サムネイル host', re: /img\.dlsite\.jp/g },
  { id: 'result-list-marker', label: '検索結果 HTML の構造マーカー', re: /search_result_list/g },
  { id: 'pagination-marker', label: 'ページャ HTML の構造マーカー', re: /global_pagination/g },
];

/**
 * テキスト 1 本を走査して違反の配列を返す。空配列 = 合格。
 * @param {string} text
 * @param {string} [source]
 * @returns {Violation[]}
 */
export function scanText(text, source = '<text>') {
  /** @type {Violation[]} */
  const violations = [];
  for (const { id, label, re } of FORBIDDEN_PATTERNS) {
    for (const match of text.matchAll(new RegExp(re.source, re.flags))) {
      violations.push({ source, patternId: id, label, sample: match[0], index: match.index });
    }
  }
  return violations;
}

/** テキストとして走査する拡張子。バイナリ（画像・フォント）は対象外。 */
const TEXT_EXT = /\.(html?|js|mjs|cjs|css|json|txt|map|svg|webmanifest)$/i;

/**
 * ディレクトリを再帰的に走査する。
 * @param {string} dir
 * @returns {Violation[]}
 */
export function scanDir(dir) {
  /** @type {Violation[]} */
  const violations = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      violations.push(...scanDir(full));
      continue;
    }
    if (!TEXT_EXT.test(entry)) continue;
    violations.push(...scanText(readFileSync(full, 'utf8'), relative(dir, full)));
  }
  return violations;
}

// ---- CLI ----
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2] ?? 'dist';
  let violations;
  try {
    violations = scanDir(dir);
  } catch (_err) {
    console.error(`dist-scan: ${dir} を読めません。先に npm run build を実行してください。`);
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error(`dist-scan: ${violations.length} 件の混入を検出しました（D2 違反）。`);
    for (const v of violations.slice(0, 20)) {
      console.error(`  ${v.source}: ${v.label} "${v.sample}"`);
    }
    process.exit(1);
  }
  console.log(`dist-scan: ${dir} に DLsite 由来の素材の混入はありません。`);
}
