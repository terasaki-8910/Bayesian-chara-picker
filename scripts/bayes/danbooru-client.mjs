#!/usr/bin/env node
/**
 * ベイズ推薦エンジン試作（PLAN「ベイズ推薦エンジン試作」）向けの Danbooru API クライアント。
 * アプリからは一切 import しない独立プロセス側の共有モジュール
 * （scripts/bayes/map-characters.mjs・sample-posts.mjs から使う）。
 *
 * 取得するのはタグ統計（タグ名・投稿件数・投稿ごとの一般タグ配列）のみ。画像本体・
 * 作者コメント・投稿者情報等は取得しない。robots.txt は `/*.json` を検索エンジンの
 * インデックス防止目的でまとめて Disallow しているが、この API 自体は Danbooru が
 * 公式に公開・文書化している統計取得用エンドポイントであり、ここでは低頻度・
 * User-Agent明示という自主規制（scripts/collect-hitomi.mjs と同じ方針）で利用する。
 * 将来アカウント登録して API key を使う場合は createDanbooruFetcher の呼び出し側で
 * ヘッダ/クエリに login・api_key を足すだけで済むようにしてある。
 */
import { pathToFileURL } from 'node:url';

/** 匿名アクセスの実測レート制限に対して十分余裕を持たせた自主規制の間隔。 */
export const REQUEST_DELAY_MS = 1_100;

export const USER_AGENT =
  'chara-picker-bayes/0.1 (+https://github.com/terasaki-8910; tag statistics only, no image/content fetch)';

const API_ROOT = 'https://danbooru.donmai.us';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @typedef {(url: string, init?: { headers?: Record<string, string> }) =>
 *   Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>} DanbooruFetchLike
 */

/**
 * scripts/collect-hitomi.mjs の createHitomiFetcher と同じ形の薄いスロットラー。
 * 呼び出し側から fetchImpl を差し替えられるので、テストでは実通信させない
 * （tests/bayes-pipeline.test.ts はすべてこの差し替えでフィクスチャ応答を返す）。
 * @param {{ fetchImpl?: DanbooruFetchLike, delayMs?: number }} [opts]
 */
export function createDanbooruFetcher({ fetchImpl = fetch, delayMs = REQUEST_DELAY_MS } = {}) {
  let lastCallAt = null;

  return async function danbooruFetch(path) {
    if (lastCallAt !== null) {
      const wait = delayMs - (Date.now() - lastCallAt);
      if (wait > 0) await sleep(wait);
    }
    lastCallAt = Date.now();
    const res = await fetchImpl(`${API_ROOT}${path}`, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) {
      throw new Error(`Danbooru API 呼び出しに失敗しました (status=${res.status}): ${path}`);
    }
    return res.json();
  };
}

/**
 * @typedef {{ name: string, category: number, post_count: number }} DanbooruTag
 */

/**
 * `base(*)` 形式のワイルドカードで、キャラクタータグ候補を投稿数の多い順で探す。
 * category=4 はキャラクタータグ（一般タグ=0、作者タグ=1、著作権タグ=3 とは別区分）。
 * @param {ReturnType<typeof createDanbooruFetcher>} danbooruFetch
 * @param {string} baseName 検索の起点になる名前（スペース済みで小文字・アンダースコア区切り）
 * @param {number} [limit]
 * @returns {Promise<DanbooruTag[]>}
 */
export async function searchCharacterTagCandidates(danbooruFetch, baseName, limit = 20) {
  const pattern = encodeURIComponent(`${baseName}*`);
  const path = `/tags.json?search[name_matches]=${pattern}&search[category]=4&search[order]=count&limit=${limit}`;
  const tags = /** @type {DanbooruTag[]} */ (await danbooruFetch(path));
  return tags;
}

/**
 * 完全一致でタグ1件の情報を引く（存在しなければ null）。
 * @param {ReturnType<typeof createDanbooruFetcher>} danbooruFetch
 * @param {string} tagName
 * @returns {Promise<DanbooruTag | null>}
 */
export async function fetchTagExact(danbooruFetch, tagName) {
  const path = `/tags.json?search[name]=${encodeURIComponent(tagName)}&limit=1`;
  const tags = /** @type {DanbooruTag[]} */ (await danbooruFetch(path));
  return tags[0] ?? null;
}

/**
 * タグのwikiページの`other_names`配列を取得する（500体拡張の日本語名解決用、
 * 2026-08-02追加）。実地確認（宝鐘マリン・狐坂ワカモ・初音ミク・ゼルダ姫）では
 * 配列の先頭側に日本語表記の正式名が入っている傾向が高い——このプロジェクトは
 * 「キャラ名を記憶から出さない」方針(SPEC§4.3)のため、日本語名もここから裏取り
 * してから採用する（記憶だけで書いて「宝鐘マリン」を「鳳凰マリン」と誤記した
 * 実例あり）。wikiページが存在しなければ空配列を返す。
 * @param {ReturnType<typeof createDanbooruFetcher>} danbooruFetch
 * @param {string} tagName
 * @returns {Promise<string[]>}
 */
export async function fetchWikiOtherNames(danbooruFetch, tagName) {
  const page = await fetchWikiPage(danbooruFetch, tagName);
  return page?.other_names ?? [];
}

/**
 * wikiページ本体（本文・other_names）を取得する。存在しなければ null
 * （500体拡張の候補シリーズ解決用、2026-08-02追加。本文中の`[[シリーズ名]]`
 * リンクからシリーズタグを機械的に裏取りするために使う——キャラ名解決と同じく
 * 記憶からシリーズを憶測しない方針、SPEC §4.3）。
 * @param {ReturnType<typeof createDanbooruFetcher>} danbooruFetch
 * @param {string} tagName
 * @returns {Promise<{ body?: string, other_names?: string[] } | null>}
 */
export async function fetchWikiPage(danbooruFetch, tagName) {
  const path = `/wiki_pages/${encodeURIComponent(tagName)}.json`;
  try {
    return /** @type {{ body?: string, other_names?: string[] }} */ (await danbooruFetch(path));
  } catch (_err) {
    return null;
  }
}

/**
 * wiki本文のDanbooru内部リンク`[[Name]]`・`[[Name|Display]]`を出現順に抽出する
 * （500体拡張の候補シリーズ解決用、2026-08-02追加）。リンク先ページ名をそのまま
 * 返す——タグ名への変換（空白→アンダースコア・小文字化）は呼び出し側で行う。
 * @param {string} body
 * @returns {string[]}
 */
export function extractWikiLinks(body) {
  const matches = [...body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)];
  return matches.map((m) => m[1].trim());
}

/** 文字列に日本語文字（ひらがな・カタカナ・漢字）が含まれるか。 */
export function containsJapanese(text) {
  return /[぀-ヿ㐀-鿿]/.test(text);
}

/**
 * 文字列にひらがな・カタカナが含まれるか。CJK統合漢字（㐀-鿿）は日本語・中国語
 * 双方で使われる（簡体字も同じUnicodeブロックに入る）ため、漢字の有無だけでは
 * 日本語と断定できない——実際に`warrior_of_light_(ff14)`のother_namesで
 * 中国語表記「光之战士」を日本語名として誤採用した実例あり（2026-08-02発覚）。
 * かな（この関数）の有無を日本語表記の一次判定に使い、`containsJapanese`は
 * 「かな入り候補が無い場合の漢字のみフォールバック」を意識して呼び分ける。
 * @param {string} text
 * @returns {boolean}
 */
export function containsKana(text) {
  return /[぀-ヿ]/.test(text);
}

/**
 * 中国語の音訳（外国語名の当て字）でほぼ専用に使われ、日本語の語彙・人名には
 * 実質現れない漢字の一覧。かな入り候補が無い場合の「漢字のみ候補」が中国語表記か
 * 日本語表記かを見分ける二次フィルタに使う——`warrior_of_light_(ff14)`の
 * 「光之战士」(战)・`tifa_lockhart`の簡体字表記「蒂法」(蒂)のような実例を踏まえる
 * （2026-08-02）。網羅的ではないので過信しない：ここに引っかからなくても
 * 中国語である可能性はゼロではなく、最終的な人名確認は後段のniconico/wikidata
 * マッピング（SPEC通りの二次照合）に委ねる。
 * @param {string} text
 * @returns {boolean}
 */
export function containsChineseTransliterationMarker(text) {
  // 文字単位で判定するため、単独でも標準的な日本語漢字として通用する文字は
  // 誤検出を招く（2026-08-02、実地確認: 「涅茨」を1単位のつもりで足したところ
  // 「茨」が独立文字として登録され、「茨木華扇」(東方Project、正しい表記)を
  // 誤ってすり抜け扱いにしていた）。同種のリスクがある「欧」(欧州等で多用)・
  // 「丘」(地名で多用)・「肯」(肯定等で多用)・「梅」(地名・人名で多用)・
  // 「机」(単独で「つくえ」の意の正規の日本語漢字)・「恩」(恩人等で多用)は
  // 中国語音訳でも使われるが日本語としての使用頻度が高すぎるため除外した。
  const markers =
    '战丝东华义语统电关门达让团际龙风归岛显继鲁娜蒂姆兹妮薇娅婕讯迪玛塔曼尤杰凯赛埃诺冯涅谢萨艾澳匹乔培朵悉弗冈岑娃丽业农沃韦罗卡拉库斯灭宫见鸢仪萤铃兰爱';
  return [...text].some((ch) => markers.includes(ch));
}

/**
 * `other_names`配列から日本語の正式表記を選ぶ共通ロジック（500体拡張のキャラ名・
 * シリーズ名の両方で使う、2026-08-02）。配列を先頭から順に見て、最初に
 * 「かな（ひらがな・カタカナ）を含む」または「中国語音訳マーカー漢字を含まない
 * 漢字のみ」を満たした要素を返す——2パス走査（配列全体からかな入りを先に探す）は
 * しない。Danbooruのother_names配列は先頭側に正式表記、後方に二次創作あだ名・
 * 多言語訳が来る傾向があり、2パス走査だと`chen`で配列先頭の正しい表記「橙」より
 * 後方のあだ名「ゆっくりちぇん」（かな入り）を誤って先に拾ってしまっていた実例がある。
 * @param {string[]} otherNames
 * @returns {{ name: string | null, confidence: 'kana' | 'kanji-only' | null }}
 */
export function pickJapaneseDisplayName(otherNames) {
  for (const name of otherNames) {
    if (containsKana(name)) return { name, confidence: 'kana' };
    if (containsJapanese(name) && !containsChineseTransliterationMarker(name)) {
      return { name, confidence: 'kanji-only' };
    }
  }
  return { name: null, confidence: null };
}

/**
 * 2タグの投稿件数（積集合）を取得する。曖昧なキャラクタータグ候補が本当に
 * 目的のシリーズ（copyrightタグ）に属すかの検証に使う——キャラタグの曖昧回避
 * カッコの表記（例: `taihou_(kancolle)`）はcopyrightタグの正式名
 * （`kantai_collection`）と文字列が一致しないことがあるため、名前の一致では
 * なく実際のタグ共起で確認する方が確実（2026-07-22、大鳳の誤対応で発覚）。
 * @param {ReturnType<typeof createDanbooruFetcher>} danbooruFetch
 * @param {string[]} tags 2つまで（Danbooru匿名APIの制限）
 * @returns {Promise<number>}
 */
export async function countPosts(danbooruFetch, tags) {
  const path = `/counts/posts.json?tags=${tags.map(encodeURIComponent).join('+')}`;
  const result = /** @type {{ counts: { posts: number } }} */ (await danbooruFetch(path));
  return result.counts.posts;
}

/**
 * `posts.json` の1ページぶんを取得する。既定では一般タグ文字列だけに絞って転送量を
 * 抑える（`only=` パラメータはDanbooru公式APIが提供するフィールド制限機構）。
 * `only` を明示すれば他フィールド（`fav_count`・`tag_string_character`等）も取れる
 * （500体拡張の候補スコアリング用、2026-08-02追加。既定値は変えていないので
 * 既存呼び出し元・テストの `only=id,tag_string_general` 固定文字列アサートは影響を
 * 受けない）。
 * @param {ReturnType<typeof createDanbooruFetcher>} danbooruFetch
 * @param {string} tag
 * @param {{ page?: number, limit?: number, only?: string }} [opts]
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function fetchPostsPage(danbooruFetch, tag, { page = 1, limit = 200, only = 'id,tag_string_general' } = {}) {
  const path = `/posts.json?tags=${encodeURIComponent(tag)}&limit=${limit}&page=${page}&only=${only}`;
  return /** @type {Record<string, unknown>[]} */ (await danbooruFetch(path));
}

/**
 * category=4 キャラクタータグを投稿数の多い順に列挙する（500体拡張の候補列挙用、
 * 2026-08-02追加）。`searchCharacterTagCandidates` と違い `name_matches` を要求せず、
 * 起点の名前無しで全キャラタグを横断的に人気順取得できる——収録候補を記憶からでは
 * なく実データの機械列挙で決める方針（SPEC §4.3）の第2の列挙元として使う。
 * Danbooru APIの`limit`上限は1000（1リクエストで取れる最大件数）。
 * @param {ReturnType<typeof createDanbooruFetcher>} danbooruFetch
 * @param {{ page?: number, limit?: number }} [opts]
 * @returns {Promise<DanbooruTag[]>}
 */
export async function listTopCharacterTags(danbooruFetch, { page = 1, limit = 1000 } = {}) {
  const path = `/tags.json?search[category]=4&search[order]=count&limit=${limit}&page=${page}`;
  return /** @type {DanbooruTag[]} */ (await danbooruFetch(path));
}

/**
 * `tag_string_general`（スペース区切り）を配列にする。空文字列は空配列にする。
 * @param {string} tagString
 * @returns {string[]}
 */
export function splitTagString(tagString) {
  return tagString.length === 0 ? [] : tagString.split(' ');
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  console.error('このファイルはライブラリです。map-characters.mjs / sample-posts.mjs から呼んでください。');
  process.exitCode = 1;
}
