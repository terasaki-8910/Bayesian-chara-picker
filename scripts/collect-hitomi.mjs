#!/usr/bin/env node
/**
 * hitomi.la 収集バッチ（SPEC 2.2 補完データ源）。アプリからは一切 import しない独立プロセス。
 * DLsite の検索が見つけられないキャラ（タイトル文字列の連続一致に依存するため、
 * 実在するのに引けないケースがある）を補うために、hitomi.la のタグ件数を使う。
 *
 * 画像・作品本文は一切取得しない。取得するのは「タグに紐づくギャラリー件数」のみ
 * （SPEC 3: 画像・サムネイル・タイトルの同梱および表示は禁止のまま）。
 *
 * 実装の元ネタは非公開の内部プロトコルではなく、hitomi.la 自身の公式フロントエンドが
 * ブラウザから読み込む静的ファイル（`n/<area>/<tag>-all.nozomi`）への単純な GET。
 * 画像URLの難読化ロジック（gg.js の m()/b()/s()）は使わない — 件数を数えるだけなら不要。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** hitomi.la の robots.txt は Crawl-delay を明示していない。静的ファイル1本のGETと
 * DLsiteのフルページレンダリングでは負荷が桁違いなので、自主的に短めの間隔に留める。 */
export const REQUEST_DELAY_MS = 1_500;

export const USER_AGENT =
  'chara-picker-collect/0.1 (+https://github.com/terasaki-8910; hitomi nozomi tag count only, no image/content fetch)';

const NOZOMI_DOMAIN = 'https://ltn.gold-usergeneratedcontent.net';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * collect.mjs の createPoliteFetcher とは独立させる — あちらは DLsite 用の
 * User-Agent をハードコードして上書きする実装で、呼び出し側から差し替えられない
 * （B4 で固定された「凍結シンボル」なので変更しない）。hitomi.la 用に別サイト・
 * 別UA・別間隔の薄いスロットラーをここに持つ。
 * @param {{ fetchImpl?: typeof fetch, delayMs?: number }} [opts]
 */
export function createHitomiFetcher({ fetchImpl = fetch, delayMs = REQUEST_DELAY_MS } = {}) {
  let lastCallAt = null;

  return async function hitomiFetch(url, init = {}) {
    if (lastCallAt !== null) {
      const wait = delayMs - (Date.now() - lastCallAt);
      if (wait > 0) await sleep(wait);
    }
    lastCallAt = Date.now();
    return fetchImpl(url, { ...init, headers: { ...init.headers, 'User-Agent': USER_AGENT } });
  };
}

/**
 * タグ件数用の nozomi ファイル URL を組み立てる。
 * スペースは `%20` でエンコードする（`+` や `_` ではない。実測で確認済み — `_` は
 * 404 になる。DLsite の buildSearchUrl とは別サイトなのでエンコード規則も別）。
 * @param {{ area: 'character' | 'series', tag: string }} opts
 */
export function buildNozomiUrl({ area, tag }) {
  const encodedTag = tag.split(' ').map(encodeURIComponent).join('%20');
  return `${NOZOMI_DOMAIN}/n/${area}/${encodedTag}-all.nozomi`;
}

/**
 * nozomi バイナリ（4バイトビッグエンディアン i32 の配列）をギャラリーIDの集合に変換する。
 * @param {ArrayBuffer} buffer
 * @returns {Set<number>}
 */
export function parseNozomiIds(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ids = new Set();
  for (let i = 0; i + 4 <= bytes.length; i += 4) {
    ids.add(view.getInt32(i, false));
  }
  return ids;
}

/**
 * 指定タグのギャラリーID集合を取得する。タグが存在しない場合 404 が返るので空集合にする
 * （DLsiteの0件と同じ扱い。エラーにしない）。
 * @param {(url: string, init?: object) => Promise<Response>} politeFetch
 * @param {'character' | 'series'} area
 * @param {string} tag
 * @returns {Promise<Set<number>>}
 */
async function fetchGalleryIds(politeFetch, area, tag) {
  const url = buildNozomiUrl({ area, tag });
  const res = await politeFetch(url);
  if (res.status === 404) return new Set();
  if (!res.ok) {
    throw new Error(`hitomi収集に失敗しました (status=${res.status}): ${url}`);
  }
  const buf = await res.arrayBuffer();
  return parseNozomiIds(buf);
}

/**
 * `HitomiQuery` から最終的な件数を求める。`series` があれば character タグと
 * series タグの積集合を取る（同名キャラが他作品に存在する場合の誤カウント対策。
 * 実例: hitomi の character:yamato は 878 件あるが、大半は ONE PIECE / NARUTO の
 * ヤマトで、series:azur lane と積集合すると 11 件まで絞れる）。
 * @param {(url: string, init?: object) => Promise<Response>} politeFetch
 * @param {{ character: string, series: string | null }} query
 * @param {Map<string, Set<number>>} seriesCache 同一実行内で series タグを使い回すキャッシュ
 */
export async function countForHitomiQuery(politeFetch, { character, series }, seriesCache) {
  const characterIds = await fetchGalleryIds(politeFetch, 'character', character);
  if (series === null) {
    return { galleryCount: characterIds.size, seriesFilter: null };
  }

  if (!seriesCache.has(series)) {
    seriesCache.set(series, await fetchGalleryIds(politeFetch, 'series', series));
  }
  const seriesIds = seriesCache.get(series);

  let intersection = 0;
  for (const id of characterIds) {
    if (seriesIds.has(id)) intersection += 1;
  }
  return { galleryCount: intersection, seriesFilter: series };
}

const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 5_000;

/**
 * `data/characters.json` の `hitomiQuery !== null` を回して `data/supply.json` の
 * `[id].hitomi` を埋める。DLsite 側のフィールド（pageCount 等）は変更しない —
 * 該当キャラの `data/supply.json` エントリは事前に `npm run collect` で
 * 作成済みであることを前提にする（`dlsiteQuery` は全キャラで設定済みのため）。
 *
 * collect.mjs と同じく、1 キャラ終わるごとに保存し、既に `.hitomi` が入っている
 * キャラはスキップする（＝再実行で再開）。
 */
async function main() {
  const dataDir = new URL('../data/', import.meta.url);
  const charactersPath = fileURLToPath(new URL('characters.json', dataDir));
  const supplyPath = fileURLToPath(new URL('supply.json', dataDir));
  const characters = JSON.parse(readFileSync(charactersPath, 'utf8'));

  let supply = {};
  try {
    supply = JSON.parse(readFileSync(supplyPath, 'utf8'));
  } catch (_err) {
    console.error('data/supply.json が見つかりません。先に npm run collect（DLsite）を実行してください。');
    process.exitCode = 1;
    return;
  }

  const hitomiFetch = createHitomiFetcher({});

  const missingEntry = characters
    .filter((c) => c.hitomiQuery !== null && supply[c.id] === undefined)
    .map((c) => c.id);
  if (missingEntry.length > 0) {
    console.error(`data/supply.json に対応エントリが無いキャラがいます（先に npm run collect を実行）: ${missingEntry.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const pending = characters.filter((c) => c.hitomiQuery !== null && supply[c.id].hitomi === null);
  if (pending.length === 0) {
    console.log('hitomi収集対象は全て取得済みです。');
    return;
  }
  console.log(`hitomi収集対象 ${pending.length} 件`);

  const seriesCache = new Map();

  for (const [index, character] of pending.entries()) {
    console.log(`[${index + 1}/${pending.length}] ${character.name} を収集中... (hitomi)`);
    let entry;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const result = await countForHitomiQuery(hitomiFetch, character.hitomiQuery, seriesCache);
        entry = { ...result, fetchedAt: new Date().toISOString() };
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
      console.error(`\n[${character.name}] のhitomi収集に失敗しました（${MAX_RETRIES}回試行）: ${lastErr.message}`);
      console.error('ここまでの結果は data/supply.json に保存済みです。再実行すると続きから再開します。');
      process.exitCode = 1;
      return;
    }

    supply[character.id] = { ...supply[character.id], hitomi: entry };
    writeFileSync(supplyPath, `${JSON.stringify(supply, null, 2)}\n`);
  }

  console.log(`完了。${pending.length} 件の hitomi データを data/supply.json に書き込みました。`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  await main();
}
