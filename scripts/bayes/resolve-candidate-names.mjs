#!/usr/bin/env node
/**
 * 500体拡張 Stage 1: 候補382件の日本語名をDanbooru wiki other_namesから解決する
 * （2026-08-02）。記憶からの憶測ではなく実データの裏取りを徹底する（宝鐘マリンを
 * 鳳凰マリンと誤記した実例を受けて追加）。
 *
 * other_names配列を先頭から順に見て、最初に「採用してよい」と判定できた要素を
 * 採用する（要素の並び順を尊重する——理由は下の`resolveJapaneseName`のコメント
 * 参照）。見つからなければ resolvedName: null のままneeds-knowledge（人力確認）に
 * 回す——このプロジェクトはキャラ名を記憶から出さない方針（SPEC §4.3）なので、
 * 確認できない名前は空欄より安全側の「保留」にする。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDanbooruFetcher, fetchWikiOtherNames, pickJapaneseDisplayName } from './danbooru-client.mjs';

/**
 * 選定ロジック本体は`pickJapaneseDisplayName`（danbooru-client.mjs、シリーズ名解決
 * (resolve-candidate-series.mjs)とも共有）。kanji-only採用分は最終確定ではなく、
 * 後段のniconico/wikidataマッピング（二次照合、乖離があればname修正）で
 * 裏取りを続ける。
 */
export async function resolveJapaneseName(danbooruFetch, tag) {
  const otherNames = await fetchWikiOtherNames(danbooruFetch, tag);
  const { name, confidence } = pickJapaneseDisplayName(otherNames);
  return { otherNames, resolvedName: name, confidence };
}

async function main() {
  const stateDir = new URL('../../state/expansion/', import.meta.url);
  const candidatesPath = fileURLToPath(new URL('candidates.json', stateDir));
  const c = JSON.parse(readFileSync(candidatesPath, 'utf8'));
  const danbooruFetch = createDanbooruFetcher({});

  const allTags = [
    ...c.rankedCandidates.map((x) => ({ ref: x, tag: x.tag })),
    ...c.priorityResults.flatMap((p) => p.characters.map((ch) => ({ ref: ch, tag: ch.tag }))),
  ];

  let kana = 0;
  let kanjiOnly = 0;
  let unresolved = 0;
  for (const [index, { ref, tag }] of allTags.entries()) {
    const { otherNames, resolvedName, confidence } = await resolveJapaneseName(danbooruFetch, tag);
    ref.otherNames = otherNames;
    ref.resolvedName = resolvedName;
    ref.resolvedNameConfidence = confidence;
    if (confidence === 'kana') kana++;
    else if (confidence === 'kanji-only') kanjiOnly++;
    else unresolved++;
    if ((index + 1) % 50 === 0) {
      console.log(`[${index + 1}/${allTags.length}] 日本語名解決中... (直近: ${tag} -> ${resolvedName ?? '未解決'})`);
    }
  }

  writeFileSync(candidatesPath, `${JSON.stringify(c, null, 2)}\n`);
  console.log(`\n完了。${allTags.length}件中 かな入り${kana}件 / 漢字のみ${kanjiOnly}件 / 未解決${unresolved}件`);
  const kanjiOnlyList = allTags.filter((x) => x.ref.resolvedNameConfidence === 'kanji-only').map((x) => `${x.tag} -> ${x.ref.resolvedName}`);
  console.log('漢字のみ採用一覧（要目視確認）:', JSON.stringify(kanjiOnlyList, null, 1));
  const unresolvedTags = allTags.filter((x) => !x.ref.resolvedName).map((x) => x.tag);
  console.log('未解決タグ一覧:', JSON.stringify(unresolvedTags, null, 1));
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
