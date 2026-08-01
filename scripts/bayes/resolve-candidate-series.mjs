#!/usr/bin/env node
/**
 * 500体拡張 Stage 1: rankedCandidates（優先3作品以外の候補）の作品(series)を
 * Danbooru wikiページ本文の内部リンクから機械的に裏取りする（2026-08-02）。
 * キャラ名と同じく「記憶からシリーズを憶測しない」方針（SPEC §4.3）——本文の
 * `[[作品名]]`リンクをcategory=3(著作権)タグとして実在検証し、キャラタグとの
 * 共起率が一定以上あるものだけ採用する（本文中で言及されただけの無関係作品を除外）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  countPosts,
  createDanbooruFetcher,
  extractWikiLinks,
  fetchTagExact,
  fetchWikiPage,
  pickJapaneseDisplayName,
} from './danbooru-client.mjs';

const MAX_LINK_ATTEMPTS = 6;
const MIN_SERIES_OVERLAP = 0.5;

function toTagForm(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * @param {ReturnType<typeof createDanbooruFetcher>} danbooruFetch
 * @param {string} tag
 * @param {number} postCount
 */
async function resolveSeriesForCandidate(danbooruFetch, tag, postCount) {
  const page = await fetchWikiPage(danbooruFetch, tag);
  if (!page?.body) return { seriesTag: null };
  const links = extractWikiLinks(page.body).slice(0, MAX_LINK_ATTEMPTS);
  for (const link of links) {
    const seriesTag = await fetchTagExact(danbooruFetch, toTagForm(link));
    if (!seriesTag || seriesTag.category !== 3 || seriesTag.post_count === 0) continue;
    const overlapCount = await countPosts(danbooruFetch, [tag, seriesTag.name]);
    const overlap = postCount > 0 ? overlapCount / postCount : 0;
    if (overlap < MIN_SERIES_OVERLAP) continue;
    const seriesPage = await fetchWikiPage(danbooruFetch, seriesTag.name);
    const ja = pickJapaneseDisplayName(seriesPage?.other_names ?? []);
    return { seriesTag: seriesTag.name, overlap, seriesNameJa: ja.name, seriesNameConfidence: ja.confidence };
  }
  return { seriesTag: null };
}

async function main() {
  const stateDir = new URL('../../state/expansion/', import.meta.url);
  const candidatesPath = fileURLToPath(new URL('candidates.json', stateDir));
  const c = JSON.parse(readFileSync(candidatesPath, 'utf8'));
  const danbooruFetch = createDanbooruFetcher({});

  let resolved = 0;
  let unresolved = 0;
  for (const [index, ref] of c.rankedCandidates.entries()) {
    const result = await resolveSeriesForCandidate(danbooruFetch, ref.tag, ref.postCount);
    ref.seriesTag = result.seriesTag;
    ref.seriesOverlap = result.overlap ?? null;
    ref.seriesNameJa = result.seriesNameJa ?? null;
    ref.seriesNameConfidence = result.seriesNameConfidence ?? null;
    if (result.seriesTag) resolved++;
    else unresolved++;
    if ((index + 1) % 25 === 0) {
      console.log(
        `[${index + 1}/${c.rankedCandidates.length}] シリーズ解決中... (直近: ${ref.tag} -> ${result.seriesTag ?? '未解決'})`,
      );
    }
  }

  writeFileSync(candidatesPath, `${JSON.stringify(c, null, 2)}\n`);
  console.log(`\n完了。${c.rankedCandidates.length}件中 解決${resolved}件 / 未解決${unresolved}件`);
  const unresolvedTags = c.rankedCandidates.filter((x) => !x.seriesTag).map((x) => x.tag);
  console.log('未解決タグ一覧:', JSON.stringify(unresolvedTags, null, 1));
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
