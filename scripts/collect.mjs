#!/usr/bin/env node
/**
 * DLsite 収集バッチ（SPEC 2.2）。アプリからは一切 import しない独立プロセス。
 * 検索結果の 1 ページ目のみを取得し、件数の目安と媒体別内訳を data/supply.json に書く。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** robots.txt の `Crawl-delay: 10` を厳守する（秒未満に短縮しない）。 */
export const CRAWL_DELAY_MS = 10_000;

/** 検索結果の 1 ページあたり件数。DLsite 側の `per_page` パラメータと一致させる。 */
export const PER_PAGE = 30;

/** 連絡手段を含む User-Agent（SPEC 4.2）。 */
export const USER_AGENT =
  'chara-picker-collect/0.1 (+https://github.com/terasaki-8910; page/1 only, crawl-delay 10s)';

/** CLI 実行時に媒体別の傾向を追加取得する work_type（SPEC 2.3）。 */
const WORK_TYPES = ['doujinshi', 'voice', 'game'];

const SEARCH_BASE = 'https://www.dlsite.com/maniax/fsr/=/language/jp/sex_category%5B0%5D/male';

/**
 * DLsite 検索結果 1 ページ目の URL を組み立てる。
 * `page` を受け取っても無視する — 2 ページ目以降を生成できる引数を持たせない（B1）。
 * @param {{ keyword: string, workType?: string }} opts
 * @returns {string}
 */
export function buildSearchUrl({ keyword, workType }) {
  const segments = [SEARCH_BASE, `keyword/${encodeURIComponent(keyword)}`];
  if (workType) {
    segments.push(`work_type_category%5B0%5D/${encodeURIComponent(workType)}`);
  }
  segments.push('order/trend', `per_page/${PER_PAGE}`, 'page/1');
  return `${segments.join('/')}/`;
}

/** 指定ミリ秒だけ待つ。fake timers から観測できるよう setTimeout を使う。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @typedef {(url: string, init: { headers: Record<string, string> }) =>
 *   Promise<{ ok: boolean, status: number, text: () => Promise<string> }>} FetchLike
 */

/**
 * `Crawl-delay: 10` を守る fetch ラッパーを作る。呼び出し間隔が delayMs 未満なら待つ。
 * 実時間の setTimeout を注入可能にし、テストから fake timers で検証できるようにする（B3）。
 * @param {{ fetchImpl?: FetchLike, delayMs?: number }} [opts]
 */
export function createPoliteFetcher({ fetchImpl = fetch, delayMs = CRAWL_DELAY_MS } = {}) {
  let lastCallAt = null;

  return async function politeFetch(url, init = {}) {
    if (lastCallAt !== null) {
      const wait = delayMs - (Date.now() - lastCallAt);
      if (wait > 0) {
        await sleep(wait);
      }
    }
    lastCallAt = Date.now();
    return fetchImpl(url, { ...init, headers: { ...init.headers, 'User-Agent': USER_AGENT } });
  };
}

/**
 * 総ヒット数の目安を算出する。1 ページに収まる場合は実数が確定するので推定にしない（B7）。
 */
export function estimateRange({ pageCount, itemsOnFirstPage, perPage }) {
  if (pageCount === 0) return [0, 0];
  if (pageCount === 1) return [itemsOnFirstPage, itemsOnFirstPage];
  return [(pageCount - 1) * perPage + 1, pageCount * perPage];
}

/**
 * `id` 属性が一致する div 要素の内側 HTML を、タグの入れ子を数えて正確に取り出す。
 * 最初に現れた `</div>` で打ち切ると、要素内にさらに div が入れ子になっている
 * 実サイトの HTML で取りこぼす（B6 の罠と同種の失敗）。
 */
function extractElementById(html, id) {
  const openTag = new RegExp(`<div[^>]*\\bid=["']${id}["'][^>]*>`, 'i');
  const start = openTag.exec(html);
  if (!start) return null;

  const contentStart = start.index + start[0].length;
  const tagPattern = /<div\b[^>]*>|<\/div>/gi;
  tagPattern.lastIndex = contentStart;

  let depth = 1;
  let match;
  while ((match = tagPattern.exec(html)) !== null) {
    if (match[0].toLowerCase() === '</div>') {
      depth -= 1;
      if (depth === 0) {
        return html.slice(contentStart, match.index);
      }
    } else {
      depth += 1;
    }
  }
  return html.slice(contentStart);
}

/**
 * 検索結果 HTML を解析する。総ヒット数は `global_pagination` の「最後へ」リンクの
 * `/page/N/` から読む（本文には数値として存在しない）。作品 ID の計数は
 * `search_result_list` の内側にスコープする（B6: ページ全体には推薦枠の ID が混ざる）。
 */
export function parseSearchResult(html, { perPage = PER_PAGE } = {}) {
  const resultListHtml = extractElementById(html, 'search_result_list') ?? '';
  const itemsOnFirstPage = new Set(resultListHtml.match(/RJ\d{6,}/g) ?? []).size;

  const lastPageLink = /<a[^>]*href="([^"]*)"[^>]*>\s*最後へ\s*<\/a>/.exec(html);
  let pageCount;
  if (lastPageLink) {
    const pageNumber = /\/page\/(\d+)\//.exec(lastPageLink[1]);
    pageCount = pageNumber ? Number(pageNumber[1]) : 1;
  } else {
    pageCount = itemsOnFirstPage > 0 ? 1 : 0;
  }

  return {
    pageCount,
    itemsOnFirstPage,
    estimatedRange: estimateRange({ pageCount, itemsOnFirstPage, perPage }),
  };
}

async function fetchAndParse(politeFetch, opts) {
  const url = buildSearchUrl(opts);
  const res = await politeFetch(url);
  if (!res.ok) {
    throw new Error(`収集に失敗しました (status=${res.status}): ${url}`);
  }
  const html = await res.text();
  return parseSearchResult(html, { perPage: PER_PAGE });
}

/**
 * `data/characters.json` の `dlsiteQuery !== null` を回して `data/supply.json` を書く。
 * wave 2（character-dataset）で初めて使う経路。
 */
async function main() {
  const dataDir = new URL('../data/', import.meta.url);
  const characters = JSON.parse(readFileSync(fileURLToPath(new URL('characters.json', dataDir)), 'utf8'));
  const politeFetch = createPoliteFetcher({});

  const supply = {};
  for (const character of characters) {
    if (character.dlsiteQuery === null) continue;

    const overall = await fetchAndParse(politeFetch, { keyword: character.dlsiteQuery });
    const byWorkType = {};
    for (const workType of WORK_TYPES) {
      const result = await fetchAndParse(politeFetch, { keyword: character.dlsiteQuery, workType });
      byWorkType[workType] = result.pageCount;
    }

    supply[character.id] = {
      pageCount: overall.pageCount,
      estimatedRange: overall.estimatedRange,
      byWorkType,
      fetchedAt: new Date().toISOString(),
    };
  }

  writeFileSync(fileURLToPath(new URL('supply.json', dataDir)), `${JSON.stringify(supply, null, 2)}\n`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  await main();
}
