#!/usr/bin/env node
/**
 * data/characters.json の全キャラについて、対応するニコニコ大百科の記事タイトルを
 * 導出・検証し、data/bayes/niconico-map.json（監査証跡・プロース非混入）へ書き出す。
 * 記事本文の正規化済みプレーンテキストは gitignore の
 * state/bayes-pipeline/niconico/<id>.json にのみキャッシュする
 * （scripts/bayes/llm-extract.mjs が読む。プロース本文をコミットツリーに置かない
 * ——P0-P4以来の前提を踏襲）。
 *
 * 導出の優先順位:
 *   1. data/bayes/niconico-overrides.json の overrides[id]（手書き強制指定・除外）
 *   2. character.name（日本語表記）で /a/<name> を直接試行
 *   3. character.aliases の各値で同様に試行（英語名記事が別途存在するケースの救済）
 *   4. 記事が見つかった場合、本文に character.series と character.name の両方が
 *      緩く出現するかで検証する（同名別作品キャラの記事を誤って掴む恐れがあるため
 *      ——map-wikidata.mjsのseriesLabelMatches、map-characters.mjsの
 *      seriesOverlapRatioと同じ動機）。シリーズ名だけの照合では不十分だったことが
 *      実地確認で判明している——fate-scathachのaliases「ランサー」（Fateの
 *      サーヴァントクラス名）が実在の記事を持ち、その記事はシリーズ名「Fate」を
 *      含むためseriesのみの照合では素通りしてしまうが、スカサハ個人の記事では
 *      ない疑いが強い。本人名の出現も必須にすることでこの種の「シリーズは合って
 *      いるが記事の主題が別概念」の誤採用を防ぐ（2026-07-25、mapOneCharacter初回
 *      実行中に発覚）。検証できなければ安全側で既定除外（title=null。qid=nullと
 *      同じ扱い）。
 *   5. どの候補も見つからなければ title=null（このキャラはLLM抽出尤度なし。
 *      Danbooru/16軸/Wikidataソースのみで参加する——被覆率の限界はPLANのリスク1で
 *      織り込み済みの安全な劣化）
 *
 * 再実行時は checkedAt が7日以内のエントリをスキップする（--force で無視、
 * --char <id> で単体のみ強制再チェック）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createNiconicoFetcher, fetchArticleHtml, htmlToText } from './niconico-client.mjs';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SITE_ROOT = 'https://dic.nicovideo.jp';

function normalizeForMatch(s) {
  return s
    .toLowerCase()
    .replace(/[_\-:!?！？・、。'’()（）]/g, '')
    .replace(/\s+/g, ''); // \s は全角スペース(U+3000)も含めて空白を丸ごと除去する
}

function looseMatch(a, b) {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (na.length === 0 || nb.length === 0) return false;
  return na.includes(nb) || nb.includes(na);
}

/**
 * 本文にシリーズ名が緩く出現するか。ニコニコ大百科の記事は冒頭が
 * 「○○とは、△△(作品名)に登場するキャラクターである。」という定型文のことが多く、
 * シリーズ名の完全一致でなくとも大抵は素通しできる。ただし正式名称と記事内の
 * 略称表記（例:「Re:ゼロから始める異世界生活」⇔「リゼロ」）が部分文字列関係に
 * ない場合は検出できない——その場合は安全側の要レビューに回るだけで誤採用は
 * しない（Danbooru/Wikidataと同じ「過小被覆は安全、過大採用は危険」という
 * 一貫した設計方針）。
 * @param {string} articleText htmlToTextで正規化済みの本文
 * @param {string} seriesJa character.series
 */
function seriesVerified(articleText, seriesJa) {
  return looseMatch(articleText, seriesJa);
}

/**
 * 本文にキャラ自身の名前(character.name、日本語表記)が緩く出現するか。
 * シリーズ名だけの照合では「同じ作品世界の別概念の記事」を誤って通してしまう
 * ことが実地確認で判明した（2026-07-25、fate-scathachのaliases経由の候補
 * 「ランサー」——Fateのサーヴァントクラス名——が実在の記事を持ち、その記事は
 * 当然「Fate」というシリーズ名を含むためseriesVerifiedだけでは素通りしてしまう。
 * だがその記事はスカサハ個人についての記事ではなくクラス概念の解説記事である
 * 疑いが強い）。キャラ本人の名前が候補タイトル自体だけでなく本文中にも
 * 出現することを追加要求することで、「シリーズは合っているが記事の主題が
 * このキャラ個人ではない」ケースを弾く。名前候補(alias)をタイトルに使った
 * 場合でも、記事が本当にそのキャラの記事なら本文中に日本語の正式名が
 * 出てくるはずという前提に立つ（Niconico大百科の定型冒頭文パターンより）。
 * @param {string} articleText
 * @param {string} characterName character.name（日本語表記）
 */
function nameVerified(articleText, characterName) {
  return looseMatch(articleText, characterName);
}

/**
 * @param {string} articleText
 * @param {Pick<import('../../src/data/schema.ts').Character, 'series' | 'name'>} character
 */
function contentVerified(articleText, character) {
  return seriesVerified(articleText, character.series) && nameVerified(articleText, character.name);
}

function articleUrl(title) {
  return `${SITE_ROOT}/a/${encodeURIComponent(title)}`;
}

/**
 * @param {string[]} candidates
 */
function uniqueNonEmpty(candidates) {
  const seen = new Set();
  const result = [];
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    result.push(c);
  }
  return result;
}

/**
 * @param {ReturnType<typeof createNiconicoFetcher>} niconicoFetch
 * @param {Pick<import('../../src/data/schema.ts').Character, 'id' | 'name' | 'series' | 'aliases'>} character
 * @param {{ overrides: Record<string, {title: string|null, reason?: string}> }} overridesFile
 */
async function mapOneCharacter(niconicoFetch, character, overridesFile) {
  const checkedAt = () => new Date().toISOString();
  const override = overridesFile.overrides[character.id];
  if (override) {
    if (override.title === null) {
      return { title: null, reason: override.reason ?? 'override-excluded', source: 'override', checkedAt: checkedAt() };
    }
    const html = await fetchArticleHtml(niconicoFetch, override.title);
    if (html === null) {
      return { title: null, reason: `overrideのタイトル「${override.title}」が404`, source: 'override-not-found', checkedAt: checkedAt() };
    }
    return { title: override.title, url: articleUrl(override.title), text: htmlToText(html), source: 'override', checkedAt: checkedAt() };
  }

  const candidates = uniqueNonEmpty([character.name, ...(character.aliases ?? [])]);
  let unverified = null;
  for (const title of candidates) {
    const html = await fetchArticleHtml(niconicoFetch, title);
    if (html === null) continue;
    const text = htmlToText(html);
    if (contentVerified(text, character)) {
      return { title, url: articleUrl(title), text, source: 'search-verified', checkedAt: checkedAt() };
    }
    if (unverified === null) unverified = title;
  }

  if (unverified !== null) {
    return {
      title: null,
      reason: `記事「${unverified}」は存在するがシリーズ名/本人名確認不能のため除外。要レビュー→確認できればoverridesへ。`,
      source: 'low-confidence',
      candidateTitle: unverified,
      checkedAt: checkedAt(),
    };
  }
  return { title: null, reason: 'not-found', source: 'not-found', checkedAt: checkedAt() };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const charFilter = args.includes('--char') ? args[args.indexOf('--char') + 1] : null;

  const dataDir = new URL('../../data/', import.meta.url);
  const charactersPath = fileURLToPath(new URL('characters.json', dataDir));
  const overridesPath = fileURLToPath(new URL('bayes/niconico-overrides.json', dataDir));
  const mapPath = fileURLToPath(new URL('bayes/niconico-map.json', dataDir));
  const cacheDir = fileURLToPath(new URL('../../state/bayes-pipeline/niconico/', import.meta.url));

  const characters = JSON.parse(readFileSync(charactersPath, 'utf8'));
  const overridesFile = JSON.parse(readFileSync(overridesPath, 'utf8'));

  let niconicoMap = { version: 1, entries: {} };
  try {
    niconicoMap = JSON.parse(readFileSync(mapPath, 'utf8'));
  } catch (_err) {
    // 初回実行。
  }

  mkdirSync(cacheDir, { recursive: true });

  const targets = charFilter ? characters.filter((c) => c.id === charFilter) : characters;
  if (charFilter && targets.length === 0) {
    console.error(`指定されたキャラid「${charFilter}」が見つかりません。`);
    process.exitCode = 1;
    return;
  }

  const now = Date.now();
  const pending = targets.filter((c) => {
    if (force || charFilter) return true;
    const existing = niconicoMap.entries[c.id];
    if (!existing) return true;
    return now - new Date(existing.checkedAt).getTime() > SEVEN_DAYS_MS;
  });

  if (pending.length === 0) {
    console.log('全キャラ、7日以内にチェック済みです（--force で再チェック）。');
    return;
  }
  console.log(`ニコニコ大百科 記事タイトル導出対象 ${pending.length} 件`);

  const niconicoFetch = createNiconicoFetcher({});
  const needsReview = [];
  let foundCount = 0;

  for (const [index, character] of pending.entries()) {
    process.stdout.write(`[${index + 1}/${pending.length}] ${character.name} (${character.id}) ... `);
    const result = await mapOneCharacter(niconicoFetch, character, overridesFile);
    const { text, ...mapEntry } = result;
    niconicoMap.entries[character.id] = mapEntry;
    writeFileSync(mapPath, `${JSON.stringify(niconicoMap, null, 2)}\n`);

    if (result.title === null) {
      console.log(`見つからず (${result.reason})`);
      needsReview.push({ id: character.id, name: character.name, issue: result.reason });
      continue;
    }

    const cachePath = join(cacheDir, `${character.id}.json`);
    writeFileSync(
      cachePath,
      `${JSON.stringify({ title: result.title, url: result.url, text, fetchedAt: result.checkedAt }, null, 2)}\n`,
    );
    foundCount += 1;
    console.log(`${result.title} (${result.source}, ${text.length}文字)`);
  }

  console.log(
    `\n完了。${pending.length} 件中 ${foundCount} 件の記事を取得し data/bayes/niconico-map.json / state/bayes-pipeline/niconico/*.json に書き込みました。`,
  );
  if (needsReview.length > 0) {
    console.log(`\n=== 要レビュー ${needsReview.length} 件（記事なし/シリーズ確認不能） ===`);
    for (const r of needsReview) {
      console.log(`  ${r.id} (${r.name}): ${r.issue}`);
    }
    console.log('\nタイトルの誤りは data/bayes/niconico-overrides.json の overrides に手書きで追記してください。');
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
