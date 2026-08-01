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
import {
  containsChineseTransliterationMarker,
  containsJapanese,
  containsKana,
  createDanbooruFetcher,
  fetchWikiOtherNames,
} from './danbooru-client.mjs';

/**
 * other_names配列は「まずかな入り全部→次に漢字のみ全部」という2パス走査ではなく、
 * 配列の並び順どおりに1件ずつ判定する。2026-08-02、東方キャラ複数件で誤採用が発覚:
 * `chen`は配列先頭が正しい表記「橙」（かな無し）なのに、2パス走査だと後方の
 * ニコニコ大百科的あだ名「ゆっくりちぇん」（かな入り）を先に拾ってしまっていた
 * （同様に houraisan_kaguya→「てるよ」、hijiri_byakuren→「ひじぱい」、
 * kagiyama_hina→「厄リスマス」も同型の誤採用）。Danbooruのother_names配列は
 * 先頭側に正式表記、後方に二次創作あだ名・多言語訳が来る傾向があり、
 * 「かな入りかどうか」より「並び順」の方が信頼できるシグナルだった。
 * 各要素について、かな（ひらがな・カタカナ）を含むか、または中国語音訳マーカー漢字
 * （containsChineseTransliterationMarker、CJK統合漢字は日中共有ブロックなので
 * 判定に使う——`warrior_of_light_(ff14)`で中国語「光之战士」を誤採用した実例あり）を
 * 含まない漢字のみか、のどちらかを満たした最初の要素を採用する。該当なしなら
 * resolvedName: null のままneeds-knowledge（人力確認）に回す——このプロジェクトは
 * キャラ名を記憶から出さない方針（SPEC §4.3）。kanji-only採用分は最終確定ではなく、
 * 後段のniconico/wikidataマッピング（二次照合、乖離があればname修正）で
 * 裏取りを続ける。
 */
export async function resolveJapaneseName(danbooruFetch, tag) {
  const otherNames = await fetchWikiOtherNames(danbooruFetch, tag);
  for (const name of otherNames) {
    if (containsKana(name)) return { otherNames, resolvedName: name, confidence: 'kana' };
    if (containsJapanese(name) && !containsChineseTransliterationMarker(name)) {
      return { otherNames, resolvedName: name, confidence: 'kanji-only' };
    }
  }
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
