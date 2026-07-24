#!/usr/bin/env node
/**
 * ベイズ推薦エンジン試作（PLAN「P5: Wikidata + ニコニコ大百科/ローカルLLM抽出」）向けの
 * Wikidata APIクライアント。アプリからは一切importしない独立プロセス側の共有モジュール
 * （scripts/bayes/map-wikidata.mjs から使う）。
 *
 * 取得するのは構造化データ（キャラのQID・プロパティ値）のみ。Wikidataは公式に
 * 文書化されたAPIを一般公開しており、robots.txtによるAIクローラー個別ブロックの
 * 対象でもない。ただし実測でレート制限に触れる（0.3秒間隔・10リクエストで
 * "You are making too many requests to the API." というプレーンテキスト応答、
 * つまりJSONですらないエラーを確認済み。2026-07-25）ため、danbooru-client.mjsより
 * 保守的な自主規制間隔にし、`maxlag`パラメータで負荷回避に協力する。
 */

/** 実測のレート制限（0.3秒間隔で発生）に対して十分余裕を持たせた自主規制の間隔。 */
export const REQUEST_DELAY_MS = 1_200;

export const USER_AGENT =
  'chara-picker-bayes/0.1 (+https://github.com/terasaki-8910; wikidata structured facts only, no bulk dump)';

/** Wikidataが推奨する maxlag しきい値（秒）。これを超えるレプリカ遅延がある場合は
 * サーバ側がエラーを返し、bot側はリトライを遅らせるべきとされる規約。 */
const MAXLAG_SECONDS = 5;

const API_ROOT = 'https://www.wikidata.org/w/api.php';
const ENTITY_DATA_ROOT = 'https://www.wikidata.org/wiki/Special:EntityData';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @typedef {(url: string, init?: { headers?: Record<string, string> }) =>
 *   Promise<{ ok: boolean, status: number, headers?: { get(name: string): string | null }, json: () => Promise<unknown>, text: () => Promise<string> }>} WikidataFetchLike
 */

/**
 * danbooru-client.mjs の createDanbooruFetcher と同じ形の薄いスロットラー。
 * リトライは呼び出し側（map-wikidata.mjs）が collect-hitomi.mjs と同じ
 * retry-with-backoff で行う——ここは間隔維持とUA送出・エラー検出だけに専念する。
 * @param {{ fetchImpl?: WikidataFetchLike, delayMs?: number }} [opts]
 */
export function createWikidataFetcher({ fetchImpl = fetch, delayMs = REQUEST_DELAY_MS } = {}) {
  let lastCallAt = null;

  return async function wikidataFetch(url) {
    if (lastCallAt !== null) {
      const wait = delayMs - (Date.now() - lastCallAt);
      if (wait > 0) await sleep(wait);
    }
    lastCallAt = Date.now();
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });

    if (!res.ok) {
      throw new Error(`Wikidata API 呼び出しに失敗しました (status=${res.status}): ${url}`);
    }
    // レート制限時は"You are making too many requests to the API."という
    // プレーンテキスト応答（JSONではない）を200やその他のステータスで返すことがある
    // （2026-07-25実測）。res.okだけでは検出できないため、JSONパース自体を
    // レート制限検出の最終防衛線にする。
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (_err) {
      throw new Error(`Wikidata APIが非JSON応答を返しました（レート制限の疑い）: ${text.slice(0, 100)}`);
    }
  };
}

/**
 * @typedef {{ id: string, label: string, description: string }} WikidataSearchResult
 */

/**
 * 日本語ラベル/エイリアスでキャラを検索する（wbsearchentities）。
 * @param {ReturnType<typeof createWikidataFetcher>} wikidataFetch
 * @param {string} name 検索する日本語名
 * @param {number} [limit]
 * @returns {Promise<WikidataSearchResult[]>}
 */
export async function searchEntity(wikidataFetch, name, limit = 5) {
  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: name,
    language: 'ja',
    format: 'json',
    limit: String(limit),
    maxlag: String(MAXLAG_SECONDS),
  });
  const result = /** @type {{ search: { id: string, display?: { label?: { value: string } }, description?: string }[] }} */ (
    await wikidataFetch(`${API_ROOT}?${params}`)
  );
  return (result.search ?? []).map((r) => ({
    id: r.id,
    label: r.display?.label?.value ?? '',
    description: r.description ?? '',
  }));
}

/**
 * @typedef {{ qid: string, claims: Record<string, unknown[]>, labels: Record<string, { value: string }> }} WikidataEntity
 */

/**
 * QIDのエンティティ全体（claims=プロパティ値の集合）を取得する。
 * @param {ReturnType<typeof createWikidataFetcher>} wikidataFetch
 * @param {string} qid 例: "Q117229504"
 * @returns {Promise<WikidataEntity>}
 */
export async function fetchEntity(wikidataFetch, qid) {
  const result = /** @type {{ entities: Record<string, { claims: Record<string, unknown[]>, labels: Record<string, { value: string }> }> }} */ (
    await wikidataFetch(`${ENTITY_DATA_ROOT}/${qid}.json`)
  );
  const entity = result.entities[qid];
  return { qid, claims: entity.claims, labels: entity.labels };
}

/**
 * 複数エンティティ(P123・Q123のどちらも可)のja/en両方のラベルを1リクエストで
 * まとめて引く（ids=P1|P2バッチ。実測のレート制限を踏まえ、1件1リクエストは避ける。
 * wbgetentitiesはプロパティ・アイテムの両方を同じ形で扱える）。
 *
 * 両言語を返す設計にしたのは、Wikidataのエンティティが片方の言語ラベルしか
 * 持たないことがあるため（2026-07-25、原神の作品エンティティQ65059474がja
 * ラベルのみ・en無しだったことが判明——単一言語しか取らない実装だと
 * 「該当作品なのに検証失敗」という偽陰性が起きる。genshin-ayakaで発覚）。
 * @param {ReturnType<typeof createWikidataFetcher>} wikidataFetch
 * @param {string[]} ids 例: ['P1441'] や ['Q1345229']（作品エンティティのQID等）
 * @returns {Promise<Record<string, { ja: string, en: string }>>} id -> {ja, en}ラベル（無ければ空文字）
 */
export async function fetchEntityLabels(wikidataFetch, ids) {
  if (ids.length === 0) return {};
  const params = new URLSearchParams({
    action: 'wbgetentities',
    ids: ids.join('|'),
    props: 'labels',
    languages: 'ja|en',
    format: 'json',
    maxlag: String(MAXLAG_SECONDS),
  });
  const result = /** @type {{ entities: Record<string, { labels: Record<string, { value: string }> }> }} */ (
    await wikidataFetch(`${API_ROOT}?${params}`)
  );
  const labels = {};
  for (const id of ids) {
    const entityLabels = result.entities[id]?.labels;
    labels[id] = { ja: entityLabels?.ja?.value ?? '', en: entityLabels?.en?.value ?? '' };
  }
  return labels;
}

/**
 * claims から指定プロパティの値配列を取り出す（item型claimのみ対応。
 * このプロジェクトで使うP21/P31/P1884/P1340/P2048等は全てitem型かquantity/string型）。
 * @param {WikidataEntity} entity
 * @param {string} property 例: "P21"
 * @returns {{ type: string, value: unknown }[]}
 */
export function claimValuesOf(entity, property) {
  const claims = entity.claims[property];
  if (!claims) return [];
  return claims
    .map((c) => /** @type {{ mainsnak?: { datavalue?: { value: unknown, type: string } } }} */ (c).mainsnak?.datavalue)
    .filter((dv) => dv !== undefined)
    .map((dv) => ({ type: dv.type, value: dv.value }));
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  console.error('このファイルはライブラリです。map-wikidata.mjs から呼んでください。');
  process.exitCode = 1;
}
