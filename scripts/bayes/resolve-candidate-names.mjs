#!/usr/bin/env node
/**
 * 500体拡張 Stage 1: 候補382件の日本語名をDanbooru wiki other_namesから解決する
 * （2026-08-02）。記憶からの憶測ではなく実データの裏取りを徹底する（宝鐘マリンを
 * 鳳凰マリンと誤記した実例を受けて追加）。
 *
 * other_names配列の先頭側からかな（ひらがな・カタカナ）を含む最初の要素を
 * 第一候補として採用する（漢字のみの候補は中国語表記との衝突リスクがあるため
 * 採用しない——下の`resolveJapaneseName`のコメント参照）。見つからなければ
 * resolvedName: null のままneeds-knowledge（人力確認）に回す——このプロジェクトは
 * キャラ名を記憶から出さない方針（SPEC §4.3）なので、確認できない名前は空欄より
 * 安全側の「保留」にする。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  containsChineseTransliterationMarker,
  containsJapanese,
  containsKana,
  createDanbooruFetcher,
  fetchWikiOtherNames,
} from './danbooru-client.mjs';

/**
 * CJK統合漢字は日本語・中国語で共有されるUnicodeブロックのため、漢字の有無だけでは
 * 日本語と断定できない（`warrior_of_light_(ff14)`で中国語「光之战士」を誤採用した
 * 実例あり、2026-08-02）。まずかな（ひらがな・カタカナ）を含む候補を最優先で採用する
 * （最も確度が高い）。かな入り候補が無い場合は、中国語音訳マーカー漢字
 * （containsChineseTransliterationMarker）を含まない漢字のみ候補を
 * `confidence: 'kanji-only'`として次点採用する——南野陽奈・遠坂凛のような
 * 生粋の日本語キャラはかな表記の別名が登録されておらず漢字のみのことが多いため、
 * かな不在=中国語と即断すると生粋の日本語名まで棄却してしまう。それでも該当なしなら
 * resolvedName: null のままneeds-knowledge（人力確認）に回す——このプロジェクトは
 * キャラ名を記憶から出さない方針（SPEC §4.3）。kanji-only採用分は最終確定ではなく、
 * 後段のniconico/wikidataマッピング（二次照合、乖離があればname修正）で
 * 裏取りを続ける。
 */
async function resolveJapaneseName(danbooruFetch, tag) {
  const otherNames = await fetchWikiOtherNames(danbooruFetch, tag);
  const kanaName = otherNames.find((n) => containsKana(n));
  if (kanaName) return { otherNames, resolvedName: kanaName, confidence: 'kana' };
  const kanjiOnlyName = otherNames.find((n) => containsJapanese(n) && !containsChineseTransliterationMarker(n));
  if (kanjiOnlyName) return { otherNames, resolvedName: kanjiOnlyName, confidence: 'kanji-only' };
  return { otherNames, resolvedName: null, confidence: null };
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
