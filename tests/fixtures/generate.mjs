/**
 * DLsite 検索結果ページの固定フィクスチャ生成器。
 *
 * 実サイトの HTML をそのまま置くと (1) 著作物であり (2) 肥大するため、
 * B5-B10 の判定に必要な構造だけを再現した最小の HTML を生成する。
 * 再現している構造は SPEC 2.2 の実測仕様と、2026-10 の実物調査に対応:
 *   - 作品 ID は `search_result_list` の内側と外側（推薦枠）の両方に出る
 *   - 総ヒット数は本文になく、`global_pagination` の「最後へ」リンクにのみ出る
 *   - `id="search_result_list"` の要素は 2 つある。1 つ目は読み込み中の骨組み
 *     （class=loading_display、display:none、作品 ID なし）、2 つ目が表示側
 *     （class=loading_display_open）。骨組みを掴むと 1 ページ以内の結果が 0 件になる
 *   - 作品行は `<li data-list_item_product_id>` で、行の中に別の `<ul><li>`（カート操作）が
 *     入れ子になる。作品 ID は RJ のほか BJ（書籍）・VJ（ソフト）も出る
 *   - AI 生成作品は作品 URL が `/aix/work/`、`__product_attributes` に `AIG` が付く。
 *     通常作品は `/maniax/work/`
 *
 * 生成物はコミットして運用する。仕様変更時のみ `node tests/fixtures/generate.mjs`。
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

const rjId = (n) => `RJ${String(n).padStart(8, '0')}`;

/**
 * 作品行 1 件ぶん。
 * @param {{ id: string, ai: boolean }} work
 */
function resultItem({ id, ai }) {
  const floor = ai ? 'aix' : 'maniax';
  const attributes = ai ? 'RG00000001,adl,male,ICG,JPN,AIG,DLP,161' : 'RG00000002,adl,male,ICG,JPN,DLP,004';
  return `        <li
  data-list_item_product_id="${id}"      data-rec-impression="true"
  class="search_result_img_box_inner  "
>
<dl class="work_img_main"><dt class="search_img work_thumb"><div class="work_thumb_inner"><a href="https://www.dlsite.com/${floor}/work/=/product_id/${id}.html"><img src="//img.dlsite.jp/resize/images2/work/doujin/${id}_img_main.jpg" alt=""></a></div></dt>
<dd class="work_name"><a href="https://www.dlsite.com/${floor}/work/=/product_id/${id}.html">作品名は収集対象外</a></dd>
<input type="hidden" class="__product_attributes" name="__product_attributes" id="_${id}" value="${attributes}" disabled="disabled"></dl><div data-product_id="${id}" data-layout="image"><ul class="work_operation_btn table-ul"><li><p class="work_cart"><a href="https://www.dlsite.com/maniax/cart/=/product_id/${id}.html" id="_btn_cart_${id}">カートに追加</a></p></li></ul></div>
</li>`;
}

/**
 * `count` 件のうち `aiCount` 件を AI 生成にした作品の列。AI は先頭に固めず均等に散らす。
 * `prefixes` を渡すと、指定した添字の作品 ID の接頭辞を RJ 以外にする（BJ / VJ の再現）。
 */
function works({ count, startAt, aiCount, prefixes = {} }) {
  return Array.from({ length: count }, (_, i) => {
    const ai = Math.floor(((i + 1) * aiCount) / count) > Math.floor((i * aiCount) / count);
    const id = prefixes[i] ? `${prefixes[i]}${String(startAt + i).padStart(6, '0')}` : rjId(startAt + i);
    return { id, ai };
  });
}

/** 読み込み中の骨組み。作品 ID を持たない。 */
const SKELETON = `<!-- 作品結果のロード中 -->
<div
  id="search_result_list"
  class="loading_display"
  data-toggle="found"
  style="display: none;"
>
  <div class="search_skeleton_box n_worklist">
    <div class="search_skeleton_inner">
      <div class="search_skeleton_tumb"><div class="search_skeleton_img"></div></div>
      <div class="search_skeleton_detail">
        <div class="search_skeleton_title"></div>
        <div class="search_skeleton_name"></div>
      </div>
    </div>
  </div>
</div>`;

/** 表示側。0 件のときは「見つかりませんでした」と他フロアへの誘導リンクだけが入る。 */
function displayList(list) {
  const body =
    list.length === 0
      ? `  <div class="work_not_found">
    <p class="lead">条件に一致する作品は見つかりませんでした</p>
    <ul class="extend_search_list">
      <li class="extend_search_list_item"><a href="https://www.dlsite.com/appx/fsr/=/language/jp/keyword/x/">アプリを検索する</a></li>
    </ul>
  </div>`
      : `  <ul id="search_result_img_box" class="n_worklist">
${list.map(resultItem).join('\n')}
  </ul>`;
  return `<!-- 作品結果 -->
<div id="search_result_list" class="loading_display_open" data-toggle="found">
${body}
</div>`;
}

/**
 * search_result_list の外側に出る推薦枠。
 * B6 の罠そのもの: ここの ID を数えると総数が実際より大きく出る。
 */
function recommendBlock(count, startAt) {
  const items = Array.from({ length: count }, (_, i) => {
    const id = rjId(startAt + i);
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
    `/maniax/fsr/=/language/jp/sex_category%5B0%5D/male/keyword/${keyword}/order%5B0%5D/trend/per_page/30/page/${n}/show_type/3`;
  const numbered = [2, 3, 4]
    .filter((n) => n <= lastPage)
    .map((n) => `      <li><a href="${url(n)}" data-value="${n}">${n}</a></li>`)
    .join('\n');
  return `<table cellspacing="0" class="global_pagination">
  <tbody>
    <tr>
      <td class="page_no">
        <ul>
          <li><strong>1</strong></li>
${numbered}
          <li><a href="${url(lastPage)}" data-value="${lastPage}">最後へ</a></li>
        </ul>
      </td>
    </tr>
  </tbody>
</table>`;
}

function page({ keyword, list, lastPage, recommendCount }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><title>検索結果</title></head>
<body>
<div id="search_result_outer">
${SKELETON}
${displayList(list)}
${pagination(lastPage, keyword)}
</div>
${recommendBlock(recommendCount, 90000000)}
</body>
</html>
`;
}

/**
 * B5 / B6: 30 件表示・全 12 ページ。うち 19 件が AI 生成（実物の「ジークアクス」と同じ比率）。
 * ページ全体の RJ 出現数は 30 + 42 = 72（SPEC 2.2 の実測値と同じ罠）。
 */
writeFileSync(
  here('search-multi-page.html'),
  page({
    keyword: 'multi',
    list: works({ count: 30, startAt: 1000000, aiCount: 19 }),
    lastPage: 12,
    recommendCount: 42,
  }),
);

/** B7: 0 件。ページャ無し・結果リストは「見つかりません」だけ。推薦枠だけは出るので 0 と判定できねばならない。 */
writeFileSync(
  here('search-zero-hit.html'),
  page({
    keyword: 'zero',
    list: [],
    lastPage: null,
    recommendCount: 18,
  }),
);

/**
 * B7 / B8: 1 ページに収まる 17 件。ページャ無しだが結果はある。うち 6 件が AI 生成。
 * 添字 3 を BJ、添字 9 を VJ にして、RJ 以外の作品 ID も数えられることを固定する。
 */
writeFileSync(
  here('search-single-page.html'),
  page({
    keyword: 'single',
    list: works({ count: 17, startAt: 2000000, aiCount: 6, prefixes: { 3: 'BJ', 9: 'VJ' } }),
    lastPage: null,
    recommendCount: 21,
  }),
);

/** B8: 1 ページに収まる 5 件が全て AI 生成。内数が items と一致する境界。 */
writeFileSync(
  here('search-single-page-all-ai.html'),
  page({
    keyword: 'allai',
    list: works({ count: 5, startAt: 3000000, aiCount: 5 }),
    lastPage: null,
    recommendCount: 12,
  }),
);
