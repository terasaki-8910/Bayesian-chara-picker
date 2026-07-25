#!/usr/bin/env node
/**
 * data/bayes/tag-map.json でDanbooruタグが確定した各キャラについて、最新の投稿
 * （最大1000件・投稿単位の一般タグ配列）を state/bayes-pipeline/danbooru/<id>.json
 * にキャッシュする。アプリからは一切 import しない独立プロセス
 * （scripts/bayes/build-likelihoods.mjs がこのキャッシュを読む）。
 *
 * ページごとの件数が limit 未満になった時点でそのキャラの全投稿を取り終えたと
 * みなし、以降のページ取得を打ち切る（人気の低いキャラで無駄なリクエストをしない）。
 *
 * scripts/collect-hitomi.mjs と同じく、1キャラ終わるごとに保存し、既にキャッシュが
 * あるキャラはスキップする（＝再実行で再開。--force で無視、--char <id> で単体のみ）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDanbooruFetcher, fetchPostsPage, splitTagString } from './danbooru-client.mjs';

const MAX_PAGES = 5;
const PAGE_LIMIT = 200;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 指定タグの投稿を新着順に最大 MAX_PAGES×PAGE_LIMIT 件集める。
 * @param {ReturnType<typeof createDanbooruFetcher>} danbooruFetch
 * @param {string} tag
 * @returns {Promise<{ id: number, tags: string[] }[]>}
 */
export async function samplePostsForTag(danbooruFetch, tag) {
  const posts = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const pageResult = await fetchPostsPage(danbooruFetch, tag, { page, limit: PAGE_LIMIT });
    for (const p of pageResult) {
      posts.push({ id: p.id, tags: splitTagString(p.tag_string_general) });
    }
    if (pageResult.length < PAGE_LIMIT) break; // このタグの投稿はここで尽きた
  }
  return posts;
}

/**
 * 紅美鈴の髪色タグ分布（Web検証済み実測: red_hair優位）等、既知の実測に対して
 * キャッシュ済みサンプルが整合するかを確認する。サンプリングパイプライン自体
 * （タグ対応・取得・キャッシュ往復）の健全性確認であり、尤度推定式の検証ではない
 * （そちらは tests/bayes-pipeline.test.ts の estimators 単体テストが担当）。
 * @param {(id: string) => { tag: string, posts: { id: number, tags: string[] }[] } | null} loadCache
 */
export function runVerifyChecks(loadCache) {
  const checks = [
    {
      id: 'touhou-meiling',
      label: '紅美鈴: red_hairがgreen_hairより明確に優位',
      check: (cache) => {
        const red = cache.posts.filter((p) => p.tags.includes('red_hair')).length;
        const green = cache.posts.filter((p) => p.tags.includes('green_hair')).length;
        return { pass: red > green * 3, detail: `red_hair=${red}, green_hair=${green}` };
      },
    },
  ];

  const results = [];
  for (const { id, label, check } of checks) {
    const cache = loadCache(id);
    if (!cache) {
      results.push({ id, label, pass: false, detail: 'キャッシュ未取得（先に sample-posts.mjs を実行）' });
      continue;
    }
    results.push({ id, label, ...check(cache) });
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const verify = args.includes('--verify');
  const charFilter = args.includes('--char') ? args[args.indexOf('--char') + 1] : null;

  const dataDir = new URL('../../data/', import.meta.url);
  const cacheDir = new URL('../../state/bayes-pipeline/danbooru/', import.meta.url);
  const tagMapPath = fileURLToPath(new URL('bayes/tag-map.json', dataDir));
  const cacheDirPath = fileURLToPath(cacheDir);

  let tagMap;
  try {
    tagMap = JSON.parse(readFileSync(tagMapPath, 'utf8'));
  } catch (_err) {
    console.error('data/bayes/tag-map.json が見つかりません。先に scripts/bayes/map-characters.mjs を実行してください。');
    process.exitCode = 1;
    return;
  }

  const cachePathFor = (id) => fileURLToPath(new URL(`${id}.json`, cacheDir));
  const loadCache = (id) => {
    try {
      return JSON.parse(readFileSync(cachePathFor(id), 'utf8'));
    } catch (_err) {
      return null;
    }
  };

  if (verify) {
    const results = runVerifyChecks(loadCache);
    let allPass = true;
    for (const r of results) {
      console.log(`[${r.pass ? 'OK' : 'NG'}] ${r.label}: ${r.detail}`);
      if (!r.pass) allPass = false;
    }
    process.exitCode = allPass ? 0 : 1;
    return;
  }

  const targets = Object.entries(tagMap.entries)
    .filter(([id, entry]) => entry.tag !== null && (charFilter === null || id === charFilter))
    .map(([id, entry]) => ({ id, tag: entry.tag }));

  if (charFilter && targets.length === 0) {
    console.error(`指定されたキャラid「${charFilter}」はtag-map.jsonに存在しないか、tag=nullです。`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(cacheDirPath, { recursive: true });

  const pending = targets.filter(({ id }) => force || charFilter || !existsSync(cachePathFor(id)));
  if (pending.length === 0) {
    console.log('全キャラ、サンプリング済みです（--force で再取得）。');
    return;
  }
  console.log(`Danbooru投稿サンプリング対象 ${pending.length} 件`);

  const danbooruFetch = createDanbooruFetcher({});

  for (const [index, { id, tag }] of pending.entries()) {
    console.log(`[${index + 1}/${pending.length}] ${id} (${tag}) ... `);
    let posts;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        posts = await samplePostsForTag(danbooruFetch, tag);
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
      console.error(`\n[${id}] のサンプリングに失敗しました（${MAX_RETRIES}回試行）: ${lastErr.message}`);
      console.error('ここまでの結果は state/bayes-pipeline/danbooru/ に保存済みです。再実行すると続きから再開します。');
      process.exitCode = 1;
      return;
    }

    writeFileSync(cachePathFor(id), `${JSON.stringify({ tag, fetchedAt: new Date().toISOString(), posts }, null, 2)}\n`);
    console.log(`  ${posts.length}件取得`);
  }

  console.log(`\n完了。${pending.length} 件を state/bayes-pipeline/danbooru/ に書き込みました。`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
