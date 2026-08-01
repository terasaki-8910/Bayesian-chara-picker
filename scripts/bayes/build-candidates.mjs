#!/usr/bin/env node
/**
 * 500体拡張プラン Stage 0: 収録候補リストの生成（2026-08-02）。
 * アプリからは一切importしない独立プロセス。人間が承認する前提の下書きを作るだけで、
 * data/characters.json には一切書き込まない。
 *
 * 収録候補を私（Claude）の記憶からではなく実データの機械列挙で決める方針
 * （SPEC §4.3の捏造対策、§2.2bのDanbooruランキング併用の追記）を実装したもの。
 *
 * 手順:
 *   1. Danbooru category=4（キャラクタータグ）を投稿数順に列挙する
 *      （listTopCharacterTags、1リクエスト・最大1000件）。
 *   2. 既存188体の tag-map.json と突き合わせて重複を除く。
 *   3. 残った候補ごとに「1girl」タグとの共起率で性別を推定する
 *      （私の主観判断ではなくDanbooru実データの多数決。閾値 GENDER_RATIO_MIN）。
 *   4. 生存者に rating:explicit タグとの共起数を測る——作品傾向の実測（ユーザー要求：
 *      「本当に需要があって書かれてるのか」の判定）。
 *   5. 優先3作品（シャインポスト/お兄ちゃんはおしまい!/ごちうさ）は投稿サンプリングで
 *      作中キャラをtag_string_character共起から列挙し、ランキング外でも優先枠として合流。
 *   6. rating:explicit共起数の上位から目標件数まで残し、投稿1ページのfav_count中央値を
 *      測る（悪ふざけの水増し対策の質シグナル。Danbooruは2022年10月以降AI生成画像を
 *      サイト方針で禁止しaibooruへ分離しているため、post_count自体もかさましに強いが
 *      念のためfavで補強する）。
 *   7. 結果を state/expansion/candidates.json + レビュー用Markdownへ出力。
 *
 * 全リクエストは1つの danbooruFetch インスタンスを使い回し、REQUEST_DELAY_MS(1100ms)の
 * 自主規制を全リクエスト種別（タグ列挙・性別判定・傾向計測・fav計測・シリーズ列挙）に
 * 一貫して適用する（複数インスタンスを作ると律速が効かなくなるため）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  countPosts,
  createDanbooruFetcher,
  fetchPostsPage,
  fetchTagExact,
  listTopCharacterTags,
  splitTagString,
} from './danbooru-client.mjs';

/** 1girlタグとの共起率がこれ以上なら女性キャラ候補とみなす。 */
const GENDER_RATIO_MIN = 0.3;

/**
 * 「プレイヤー自己投影アバター」パターンの除外正規表現（2026-08-02、実地確認で発覚）。
 * ブルーアーカイブ「先生」・艦これ「提督」・アズールレーン「指揮官」・崩壊：スターレイル
 * 「開拓者」等はゲーム側でプレイヤー自身を指す性別可変ロールで、ファンアートは
 * どちらの性別でも描かれるため1girl率の単純閾値では弾けない
 * （admiral_(kancolle)=53%、commander_(azur_lane)=77%等、閾値をどこに引いても
 * 実在の東方系女性キャラ(神奈子31%等、複数人絵が多い作品文化で1girl単独タグの
 * 付与率が構造的に低い)を巻き込まずに分離できなかった）。このサイトは「推薦する
 * 特定のキャラ」が主旨で自己投影アバターは趣旨に合わないため、率に関わらず除外する。
 */
const EXCLUDED_AVATAR_PATTERNS = [
  /^(doodle_)?sensei_\(blue_archive\)$/,
  /^admiral_\(kancolle\)$/,
  /^commander_\(azur_lane\)$/,
  /^(trailblazer|caelus|stelle)_\(honkai:_star_rail\)$/,
  /^aether_\(genshin_impact\)$/,
  /^(wise|belle)_\(zenless_zone_zero\)$/,
  /^rover_\(wuthering_waves\)$/,
  /^male_byleth_\(fire_emblem\)$/,
  /^fujimaru_ritsuka_\((male|female)\)$/,
  /^inkling_player_character$/,
  /^(male_)?trainer_\(pokemon\)$/,
  /^doctor_\(arknights\)$/,
  /^producer_\(idolmaster\)$/,
  /_\(male\)$/,
];

/**
 * 実地確認で1girl率の閾値をすり抜けて混入した、確認済みの男性キャラ・
 * プレイヤー選択アバター（ポケモン主人公等）・個体を指さない種族タグの個別除外
 * （2026-08-02）。クロスドレス/性転換二次創作等で1girlタグが一定数付き閾値を
 * 超えてしまうケースがある——率だけでは機械的に分離しきれないため実名で除外する。
 */
const EXCLUDED_TAGS = new Set([
  'mario',
  'uzumaki_naruto',
  'link',
  'emiya_shirou',
  'uchiha_sasuke',
  'kagamine_len',
  'natsuki_subaru',
  'cloud_strife',
  'amamiya_ren',
  'ash_ketchum',
  'selene_(pokemon)',
  'florian_(pokemon)',
  'rotom',
  'rotom_phone',
  'gardevoir',
  // 2026-08-02、1girl/1boy両方の共起数を比較する追加検証（GENDER_STRICT_CHECK）で
  // 発覚: 1girl率だけでは30-60%と紛れていたが、1boy共起数の方が多い明確な男性キャラ。
  'satou_kazuma',
  'male_rover_(wuthering_waves)',
  'denji_(chainsaw_man)',
  'twilight_(spy_x_family)',
  'scaramouche_(genshin_impact)',
  'leon_s._kennedy',
]);

/** @param {string} tagName */
export function isExcludedCandidate(tagName) {
  return EXCLUDED_TAGS.has(tagName) || EXCLUDED_AVATAR_PATTERNS.some((p) => p.test(tagName));
}
/** Danbooru API の /tags.json 1リクエストで取れる最大件数。 */
const TOP_TAGS_LIMIT = 1000;
/** 最終候補の目標件数（脱落込みで+312狙い、SPEC§6.1の供給先行方針）。 */
const TARGET_CANDIDATE_COUNT = 350;
/** fav_count中央値を測る対象（傾向スコア上位、コスト管理のため候補全体には広げない）。 */
const FAV_SAMPLE_TOP_N = 400;
/**
 * シリーズ内キャラ列挙で「本編キャラ」とみなす最低共起件数（2026-08-02実地確認で追加）。
 * tag_string_character共起は合同誌・コラボ絵経由の他作品キャラも拾ってしまい、
 * 実地確認では出現1〜4件がほぼ全てノイズ（けいおん!・アイマス・艦これ等の
 * 無関係キャラ）だった。census-hitomi.mjsの「頻度2以上」より厳しめの5に設定
 * （Danbooruはhitomi.laよりコラボ絵の混入率が高い実測傾向のため）。
 */
const MIN_SERIES_OCCURRENCE = 5;

/**
 * 優先3作品。copyrightタグの綴りはDanbooru側の実際の命名規則が確定していないため、
 * 複数の候補綴りを用意し fetchTagExact + category===3 で実在確認する
 * （map-characters.mjsのcandidatesTriedと同じ「複数候補を試して実在確認」方式）。
 */
const PRIORITY_SERIES = [
  { seriesJa: 'シャインポスト', copyrightCandidates: ['shine_post'] },
  {
    seriesJa: 'お兄ちゃんはおしまい!',
    copyrightCandidates: ['onii-chan_wa_oshimai!', 'oniichan_wa_oshimai!', 'onii-chan_wa_oshimai', 'brother_in_law'],
  },
  {
    seriesJa: 'ご注文はうさぎですか?',
    copyrightCandidates: ['gochuumon_wa_usagi_desu_ka?', 'is_the_order_a_rabbit?', 'is_the_order_a_rabbit', 'gochiusa'],
  },
];

/**
 * @param {number} matched
 * @param {number} total
 */
function female1girlRatio(matched, total) {
  return total > 0 ? matched / total : 0;
}

/**
 * 既存キャラの tag-map.json から解決済みタグ集合を作る（重複候補の除外用）。
 * @param {URL} dataDir
 */
function loadExistingTags(dataDir) {
  const tagMap = JSON.parse(readFileSync(fileURLToPath(new URL('bayes/tag-map.json', dataDir)), 'utf8'));
  const tags = new Set();
  for (const entry of Object.values(tagMap.entries)) {
    if (entry.tag) tags.add(entry.tag);
  }
  return tags;
}

/**
 * copyright候補を順に試し、category===3かつ投稿実績があるものを返す
 * （2026-08-02実地確認: 「is_the_order_a_rabbit?」はcategory=3だがpost_count=0で
 * 実際には使われていない未使用タグだった。category一致だけでは不十分）。
 * @param {ReturnType<typeof createDanbooruFetcher>} danbooruFetch
 * @param {string[]} candidates
 */
async function resolveCopyrightTag(danbooruFetch, candidates) {
  for (const candidate of candidates) {
    const tag = await fetchTagExact(danbooruFetch, candidate);
    if (tag && tag.category === 3 && tag.post_count > 0) return tag;
  }
  return null;
}

/**
 * シリーズタグの投稿を最大 maxPosts 件サンプリングし、tag_string_character の
 * 共起頻度でシリーズ内キャラを列挙する（census-hitomi.mjsのDanbooru版）。
 * @param {ReturnType<typeof createDanbooruFetcher>} danbooruFetch
 * @param {string} seriesTag
 * @param {number} maxPosts
 */
async function enumerateSeriesCharacters(danbooruFetch, seriesTag, maxPosts = 600) {
  const tally = new Map();
  const pages = Math.ceil(maxPosts / 200);
  for (let page = 1; page <= pages; page += 1) {
    const posts = await danbooruFetch(
      `/posts.json?tags=${encodeURIComponent(seriesTag)}&limit=200&page=${page}&only=id,tag_string_character`,
    );
    if (posts.length === 0) break;
    for (const post of posts) {
      for (const charTag of splitTagString(/** @type {string} */ (post.tag_string_character ?? ''))) {
        tally.set(charTag, (tally.get(charTag) ?? 0) + 1);
      }
    }
    if (posts.length < 200) break;
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * 1girl率だけでは、1girl/1boyタグが両方一定数付く（クロスドレス・チーム物二次創作等）
 * 男性キャラを弾ききれないと実地判明した（2026-08-02、このすば佐藤和真・チェンソーマン
 * デンジ・SPY×FAMILYトワイライト等がgenderRatio 38-60%で1girl率単独チェックを通過して
 * いたが、実際は1boy共起数の方が多かった）。1girl共起数が1boy共起数を上回ることを
 * 必須条件として追加する。
 * @param {ReturnType<typeof createDanbooruFetcher>} danbooruFetch
 * @param {{ name: string, post_count: number }} tag
 */
async function scoreCandidate(danbooruFetch, tag) {
  const girlCount = await countPosts(danbooruFetch, [tag.name, '1girl']);
  const genderRatio = female1girlRatio(girlCount, tag.post_count);
  const boyCount = await countPosts(danbooruFetch, [tag.name, '1boy']);
  const explicitCount = await countPosts(danbooruFetch, [tag.name, 'rating:explicit']);
  return { tag: tag.name, postCount: tag.post_count, genderRatio, boyCount, girlDominant: girlCount > boyCount, explicitCount };
}

/**
 * @param {ReturnType<typeof createDanbooruFetcher>} danbooruFetch
 * @param {string} tagName
 */
async function favCountMedian(danbooruFetch, tagName) {
  const posts = await fetchPostsPage(danbooruFetch, tagName, {
    page: 1,
    limit: 200,
    only: 'id,fav_count',
  });
  const favs = posts.map((p) => /** @type {number} */ (p.fav_count ?? 0)).sort((a, b) => a - b);
  if (favs.length === 0) return 0;
  const mid = Math.floor(favs.length / 2);
  return favs.length % 2 === 0 ? (favs[mid - 1] + favs[mid]) / 2 : favs[mid];
}

async function main() {
  const dataDir = new URL('../../data/', import.meta.url);
  const stateDir = new URL('../../state/expansion/', import.meta.url);
  mkdirSync(fileURLToPath(stateDir), { recursive: true });

  const danbooruFetch = createDanbooruFetcher({});
  const existingTags = loadExistingTags(dataDir);
  console.log(`既存タグ ${existingTags.size} 件を除外対象として読み込みました。`);

  console.log('Danbooruキャラタグ人気ランキングを取得中...');
  const topTags = await listTopCharacterTags(danbooruFetch, { limit: TOP_TAGS_LIMIT });
  const deduped = topTags.filter((t) => !existingTags.has(t.name) && !isExcludedCandidate(t.name));
  const excludedCount = topTags.filter((t) => !existingTags.has(t.name) && isExcludedCandidate(t.name)).length;
  console.log(
    `上位${topTags.length}件中、既存重複を除き、除外パターン${excludedCount}件（自己投影` +
      `アバター等）も除いた${deduped.length}件を候補として評価します。`,
  );

  const scored = [];
  for (const [index, tag] of deduped.entries()) {
    const result = await scoreCandidate(danbooruFetch, tag);
    scored.push(result);
    if ((index + 1) % 50 === 0) {
      console.log(`[${index + 1}/${deduped.length}] 性別・傾向判定 処理中... (直近: ${tag.name})`);
    }
  }

  const femaleCandidates = scored
    .filter((s) => s.genderRatio >= GENDER_RATIO_MIN && s.girlDominant)
    .sort((a, b) => b.explicitCount - a.explicitCount);
  console.log(
    `性別判定(1girl率>=${GENDER_RATIO_MIN} かつ 1girl共起>1boy共起)を通過した候補: ${femaleCandidates.length}件`,
  );

  const favTargets = femaleCandidates.slice(0, Math.min(FAV_SAMPLE_TOP_N, femaleCandidates.length));
  console.log(`fav_count中央値を測る対象: ${favTargets.length}件`);
  const withFav = [];
  for (const [index, c] of favTargets.entries()) {
    const favMedian = await favCountMedian(danbooruFetch, c.tag);
    withFav.push({ ...c, favMedian });
    if ((index + 1) % 50 === 0) {
      console.log(`[${index + 1}/${favTargets.length}] fav_count測定中... (直近: ${c.tag})`);
    }
  }

  const rankedCandidates = withFav.sort((a, b) => b.explicitCount - a.explicitCount).slice(0, TARGET_CANDIDATE_COUNT);

  console.log('優先3作品のシリーズ内キャラを列挙中...');
  const priorityResults = [];
  for (const series of PRIORITY_SERIES) {
    const copyrightTag = await resolveCopyrightTag(danbooruFetch, series.copyrightCandidates);
    if (!copyrightTag) {
      priorityResults.push({ seriesJa: series.seriesJa, resolved: false, characters: [] });
      console.log(`  ${series.seriesJa}: copyrightタグを解決できませんでした（候補: ${series.copyrightCandidates.join(', ')}）`);
      continue;
    }
    const chars = await enumerateSeriesCharacters(danbooruFetch, copyrightTag.name);
    const preFiltered = chars.filter(
      ([tagName, count]) => !existingTags.has(tagName) && !isExcludedCandidate(tagName) && count >= MIN_SERIES_OCCURRENCE,
    );
    // シリーズ内共起数(count)はそのキャラ自身の総投稿数ではないため性別判定の母数に使えない
    // （2026-08-02実地発覚: kafuu_chinoのシリーズ内共起240に対し1boy共起360という
    // 数字だけを見ると男性に見えるが、実際はchino自身の総投稿数(数千件規模)に対する
    // 1girl比率が別次元で高い。母数を取り違えていた）。各キャラ自身のタグを
    // scoreCandidateと同じロジックで再判定する。
    const newChars = [];
    for (const [tagName] of preFiltered) {
      const tagInfo = await fetchTagExact(danbooruFetch, tagName);
      if (!tagInfo || tagInfo.post_count === 0) continue;
      const scored = await scoreCandidate(danbooruFetch, { name: tagName, post_count: tagInfo.post_count });
      if (scored.genderRatio >= GENDER_RATIO_MIN && scored.girlDominant) {
        const [, count] = chars.find(([t]) => t === tagName);
        newChars.push({ tag: tagName, seriesPostCount: count, ...scored });
      }
    }
    priorityResults.push({
      seriesJa: series.seriesJa,
      resolved: true,
      copyrightTag: copyrightTag.name,
      characters: newChars,
    });
    console.log(`  ${series.seriesJa} (${copyrightTag.name}): ${newChars.length}件の新規候補キャラを検出（性別判定込み）`);
  }

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    genderRatioThreshold: GENDER_RATIO_MIN,
    targetCandidateCount: TARGET_CANDIDATE_COUNT,
    rankedCandidates,
    priorityResults,
  };
  writeFileSync(fileURLToPath(new URL('candidates.json', stateDir)), `${JSON.stringify(output, null, 2)}\n`);

  const GENDER_REVIEW_MAX = 0.5;
  const uncertainCandidates = rankedCandidates.filter((c) => c.genderRatio < GENDER_REVIEW_MAX);
  const confidentCandidates = rankedCandidates.filter((c) => c.genderRatio >= GENDER_REVIEW_MAX);

  const md = [
    '# 500体拡張 候補リスト（機械生成・人間の承認待ち）',
    '',
    `生成日時: ${output.generatedAt}`,
    `Danbooruランキング由来候補: ${rankedCandidates.length}件（性別判定1girl率>=${GENDER_RATIO_MIN}、傾向スコア降順）`,
    '',
    `**重要:** 性別判定は1girlタグ共起率のみに基づく機械推定で、確実ではありません。` +
      `既知のプレイヤー自己投影アバター・確認済み男性キャラは除外済みですが、` +
      `クロスドレス／性転換二次創作等の影響で漏れが残り得ます。特に下の` +
      `「要確認」セクション(1girl率${(GENDER_REVIEW_MAX * 100).toFixed(0)}%未満、` +
      `${uncertainCandidates.length}件)は目視確認してから承認してください。`,
    '',
    `## 要確認（1girl率${(GENDER_REVIEW_MAX * 100).toFixed(0)}%未満、${uncertainCandidates.length}件）`,
    '',
    '| Danbooruタグ | 総投稿数 | 傾向スコア | 1girl率 | fav中央値 |',
    '|---|---|---|---|---|',
    ...uncertainCandidates.map(
      (c) => `| ${c.tag} | ${c.postCount} | ${c.explicitCount} | ${(c.genderRatio * 100).toFixed(0)}% | ${c.favMedian} |`,
    ),
    '',
    `## 性別判定に自信あり（1girl率${(GENDER_REVIEW_MAX * 100).toFixed(0)}%以上、${confidentCandidates.length}件）`,
    '',
    '| Danbooruタグ | 総投稿数 | 傾向スコア | 1girl率 | fav中央値 |',
    '|---|---|---|---|---|',
    ...confidentCandidates.map(
      (c) => `| ${c.tag} | ${c.postCount} | ${c.explicitCount} | ${(c.genderRatio * 100).toFixed(0)}% | ${c.favMedian} |`,
    ),
    '',
    '## 優先3作品',
    '',
    ...priorityResults.flatMap((p) => [
      `### ${p.seriesJa}${p.resolved ? ` (${p.copyrightTag})` : '（copyrightタグ未解決）'}`,
      '',
      ...(p.resolved
        ? p.characters.map((c) => `- ${c.tag} (シリーズ内投稿${c.seriesPostCount}件)`)
        : ['要手動確認: copyrightタグの綴りをDanbooruで直接検索してください。']),
      '',
    ]),
  ].join('\n');
  writeFileSync(fileURLToPath(new URL('candidates.md', stateDir)), md);

  console.log(`\n完了。${rankedCandidates.length}件の候補 + 優先${priorityResults.length}作品を`);
  console.log('  state/expansion/candidates.json');
  console.log('  state/expansion/candidates.md');
  console.log('へ書き出しました。');
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
