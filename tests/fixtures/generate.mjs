/**
 * DLsite 検索結果ページの固定フィクスチャ生成器。
 *
 * 実サイトの HTML をそのまま置くと (1) 著作物であり (2) 肥大するため、
 * B5-B7 の判定に必要な構造だけを再現した最小の HTML を生成する。
 * 再現している構造は SPEC 2.2 の実測仕様に対応:
 *   - 作品 ID は `search_result_list` の内側と外側（推薦枠）の両方に出る
 *   - 総ヒット数は本文になく、`global_pagination` の「最後へ」リンクにのみ出る
 *
 * 生成物はコミットして運用する。仕様変更時のみ `node tests/fixtures/generate.mjs`。
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

const workId = (n) => `RJ${String(n).padStart(8, '0')}`;

/** search_result_list の内側に置く作品行。 */
function resultRows(count, startAt) {
  return Array.from({ length: count }, (_, i) => {
    const id = workId(startAt + i);
    return `      <tr>
        <td class="work_thumb">
          <a href="https://www.dlsite.com/maniax/work/=/product_id/${id}.html">
            <img src="//img.dlsite.jp/resize/images2/work/doujin/${id}_img_main.jpg" alt="">
          </a>
        </td>
        <td class="work_name">
          <a href="https://www.dlsite.com/maniax/work/=/product_id/${id}.html">作品名は収集対象外</a>
        </td>
      </tr>`;
  }).join('\n');
}

/**
 * search_result_list の外側に出る推薦枠。
 * B6 の罠そのもの: ここの ID を数えると総数が実際より大きく出る。
 */
function recommendBlock(count, startAt) {
  const items = Array.from({ length: count }, (_, i) => {
    const id = workId(startAt + i);
    return `    <li class="recommend_item">
      <a href="https://www.dlsite.com/maniax/work/=/product_id/${id}.html">${id}</a>
    </li>`;
  }).join('\n');
  return `<div id="recommend_rank" class="recommend_list">
  <ul>
${items}
  </ul>
</div>`;
}

/** 「最後へ」リンクを含むページャ。lastPage が null のときはページャ自体を出さない。 */
function pagination(lastPage, keyword) {
  if (lastPage === null) return '';
  const url = (n) =>
    `/maniax/fsr/=/language/jp/sex_category%5B0%5D/male/keyword/${keyword}/order/trend/per_page/30/page/${n}/`;
  const numbered = [2, 3, 4]
    .filter((n) => n <= lastPage)
    .map((n) => `      <li><a href="${url(n)}">${n}</a></li>`)
    .join('\n');
  return `<div class="global_pagination">
  <ul class="page_no">
      <li class="active"><span>1</span></li>
${numbered}
      <li><a href="${url(lastPage)}" class="btn_next">次へ</a></li>
      <li><a href="${url(lastPage)}">最後へ</a></li>
  </ul>
</div>`;
}

function page({ keyword, rows, rowStartAt, lastPage, recommendCount }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><title>検索結果</title></head>
<body>
<div id="search_result_outer">
  <div id="search_result_list" class="n_worklist">
    <table class="n_worklist_item">
${rows === 0 ? '' : resultRows(rows, rowStartAt)}
    </table>
  </div>
${pagination(lastPage, keyword)}
</div>
${recommendBlock(recommendCount, 90000000)}
</body>
</html>
`;
}

/**
 * B5 / B6: 30 件表示・全 12 ページ。
 * ページ全体の RJ 出現数は 30 + 42 = 72（SPEC 2.2 の実測値と同じ罠）。
 */
writeFileSync(
  here('search-multi-page.html'),
  page({
    keyword: 'multi',
    rows: 30,
    rowStartAt: 1000000,
    lastPage: 12,
    recommendCount: 42,
  }),
);

/** B7: 0 件。ページャ無し・結果リスト空。推薦枠だけは出るので 0 と判定できねばならない。 */
writeFileSync(
  here('search-zero-hit.html'),
  page({
    keyword: 'zero',
    rows: 0,
    rowStartAt: 0,
    lastPage: null,
    recommendCount: 18,
  }),
);

/** B7: 1 ページに収まる 17 件。ページャ無しだが結果はある。 */
writeFileSync(
  here('search-single-page.html'),
  page({
    keyword: 'single',
    rows: 17,
    rowStartAt: 2000000,
    lastPage: null,
    recommendCount: 21,
  }),
);
