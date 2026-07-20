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
 *
 * スペースは `%20` ではなく `+` でエンコードする。実測: このパス位置の `%20` は
 * Cloudflare 側で 403 になる（100% 再現、UA/リトライ非依存）一方、`+` は 200 かつ
 * DLsite 側が正しく複合キーワードとして解釈する（`<title>` に両方の語が入る）。
 * `dlsiteQuery` は「シリーズ名 + キャラ名」のような複合語を前提にしているため
 * （SPEC 2.1 の誤爆対策）、これを壊すと収集対象の大半で 403 になる。
 * @param {{ keyword: string, workType?: string }} opts
 * @returns {string}
 */
export function buildSearchUrl({ keyword, workType }) {
  const encodedKeyword = encodeURIComponent(keyword).replace(/%20/g, '+');
  const segments = [SEARCH_BASE, `keyword/${encodedKeyword}`];
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

/** 1 キャラの取得が失敗した際、諦めるまでの再試行回数。 */
const MAX_RETRIES = 3;

/** 再試行の前に置く追加の待ち時間。Crawl-delay の上に足す（短縮しない）。 */
const RETRY_BACKOFF_MS = 15_000;

async function collectCharacter(politeFetch, character) {
  const overall = await fetchAndParse(politeFetch, { keyword: character.dlsiteQuery });
  const byWorkType = {};
  for (const workType of WORK_TYPES) {
    const result = await fetchAndParse(politeFetch, { keyword: character.dlsiteQuery, workType });
    byWorkType[workType] = result.pageCount;
  }
  return {
    pageCount: overall.pageCount,
    estimatedRange: overall.estimatedRange,
    byWorkType,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * `data/characters.json` の `dlsiteQuery !== null` を回して `data/supply.json` を書く。
 * wave 2（character-dataset）で初めて使う経路。
 *
 * 36 体 × 4 クエリ × Crawl-delay 10 秒 ≒ 24 分かかる。途中でネットワークが
 * 落ちても失われないよう、1 キャラ終わるごとに `data/supply.json` を書き直す。
 * 既存の `supply.json` があれば読み込み、そこに無いキャラだけを対象にする
 * （＝再実行 = 再開。取得済み分を再送しない）。
 *
 * DLsite 側の一時的な 403（Cloudflare のボット判定と見られる、確率的で
 * 再試行すると通ることを実測済み）に備え、1 キャラにつき最大 MAX_RETRIES 回
 * 試す。それでも失敗したら、その時点までの結果を保存して停止する。
 */
async function main() {
  const dataDir = new URL('../data/', import.meta.url);
  const charactersPath = fileURLToPath(new URL('characters.json', dataDir));
  const supplyPath = fileURLToPath(new URL('supply.json', dataDir));
  const characters = JSON.parse(readFileSync(charactersPath, 'utf8'));
  const politeFetch = createPoliteFetcher({});

  let supply = {};
  try {
    supply = JSON.parse(readFileSync(supplyPath, 'utf8'));
  } catch (_err) {
    // 初回実行、または前回が supply.json を書く前に落ちた場合。空から始める。
  }

  const pending = characters.filter((c) => c.dlsiteQuery !== null && !(c.id in supply));
  if (pending.length === 0) {
    console.log('収集対象は全て取得済みです。');
    return;
  }
  console.log(`収集対象 ${pending.length} 件（取得済み ${Object.keys(supply).length} 件はスキップ）`);

  for (const [index, character] of pending.entries()) {
    console.log(`[${index + 1}/${pending.length}] ${character.name} を収集中...`);
    let entry;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        entry = await collectCharacter(politeFetch, character);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        console.error(`  試行 ${attempt}/${MAX_RETRIES} 失敗: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          console.error(`  ${RETRY_BACKOFF_MS / 1000}秒待って再試行します...`);
          await sleep(RETRY_BACKOFF_MS);
        }
      }
    }

    if (lastErr) {
      console.error(`\n[${character.name}] の収集に失敗しました（${MAX_RETRIES}回試行）: ${lastErr.message}`);
      console.error(`ここまでの ${Object.keys(supply).length} 件は data/supply.json に保存済みです。`);
      console.error('再実行すると、取得済みキャラをスキップして続きから再開します。');
      process.exitCode = 1;
      return;
    }

    supply[character.id] = entry;
    // 1 キャラ終わるたびに保存する。中断されても直前までの結果は残る。
    writeFileSync(supplyPath, `${JSON.stringify(supply, null, 2)}\n`);
  }

  console.log(`完了。${Object.keys(supply).length} 件を data/supply.json に書き込みました。`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  await main();
}
