import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { scanDir, scanText } from '../scripts/dist-scan.mjs';
import { readText } from './helpers/data';

const distDir = fileURLToPath(new URL('../dist', import.meta.url));

describe('D2: ビルド成果物への DLsite 素材の混入検査', () => {
  // まず走査器そのものを検証する。これが無いと「常に 0 件」の実装でも D2 が通る。
  it('検出器が作品 ID を検出する', () => {
    expect(scanText('const a = "RJ01234567";').map((v) => v.patternId)).toContain('work-id');
  });

  it('検出器が作品詳細 URL とサムネイル host を検出する', () => {
    expect(scanText('https://www.dlsite.com/maniax/work/=/product_id/x.html').map((v) => v.patternId)).toContain(
      'work-detail-url',
    );
    expect(scanText('//img.dlsite.jp/resize/foo.jpg').map((v) => v.patternId)).toContain('thumbnail-host');
  });

  it('検出器が検索結果 HTML の構造マーカーを検出する', () => {
    const ids = scanText(readText('tests/fixtures/search-multi-page.html')).map((v) => v.patternId);
    expect(ids).toContain('result-list-marker');
    expect(ids).toContain('pagination-marker');
  });

  it('検索結果ページへの外部リンクは検出しない（SPEC 2.4 で仕様上必要）', () => {
    const url = 'https://www.dlsite.com/maniax/fsr/=/keyword/%E3%83%86%E3%82%B9%E3%83%88/per_page/30/page/1/';
    expect(scanText(url)).toEqual([]);
  });

  it('正常なアプリコードは 1 件も検出しない', () => {
    expect(scanText('export const limit = 5; // 作品数の表示上限')).toEqual([]);
  });

  it('dist/ に DLsite 由来の素材が含まれない', () => {
    if (!existsSync(distDir)) {
      // dist/ はビルド後にしか存在しない。ゲート本体は scripts/ui-check.sh が
      // `npm run build` の直後に node scripts/dist-scan.mjs を実行して担保する。
      // ここで落とすと、ビルド前の `npm test` が常に赤になりリペアループが空回りする。
      return;
    }
    expect(scanDir(distDir).map((v) => `${v.source}: ${v.label} "${v.sample}"`)).toEqual([]);
  });
});
