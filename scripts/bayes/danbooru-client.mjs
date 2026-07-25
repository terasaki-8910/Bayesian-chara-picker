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
 * `posts.json` の1ページぶんを取得する。一般タグ文字列だけに絞って転送量を抑える
 * （`only=` パラメータはDanbooru公式APIが提供するフィールド制限機構）。
 * @param {ReturnType<typeof createDanbooruFetcher>} danbooruFetch
 * @param {string} tag
 * @param {{ page?: number, limit?: number }} [opts]
 * @returns {Promise<{ id: number, tag_string_general: string }[]>}
 */
export async function fetchPostsPage(danbooruFetch, tag, { page = 1, limit = 200 } = {}) {
  const path =
    `/posts.json?tags=${encodeURIComponent(tag)}&limit=${limit}&page=${page}` +
    `&only=id,tag_string_general`;
  return /** @type {{ id: number, tag_string_general: string }[]} */ (await danbooruFetch(path));
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
