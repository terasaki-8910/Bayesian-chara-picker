#!/usr/bin/env node
/**
 * data/characters.json の全キャラについて、対応する Danbooru キャラクタータグ
 * （category=4）を導出・検証し、data/bayes/tag-map.json に書き出す。
 *
 * 導出の優先順位（全候補を投稿数降順の1本の列にし、copyrightタグとの共起率
 * `seriesOverlapRatio` で確からしい順に採用——文字列一致では信用しない）:
 *   1. data/bayes/tag-overrides.json の overrides[id]（手書き強制指定・除外。
 *      共起検証スキップ＝手動確定済み扱い）
 *   2. hitomiQuery.character をそのまま bare タグとして完全一致
 *   3. 2語なら語順反転（例: 「teto kasane」→ kasane_teto。日本語語順優先）
 *   4. `${base}_(${seriesAlias})` の完全一致（bare名が一般名詞等と衝突する場合の
 *      定番の曖昧回避パターン。例: kancolle-taihou → taihou_(kantai_collection)）
 *   5. `${base}(*)` のワイルドカード検索（`search[order]=count`）
 *   6. 2語以上なら先頭語（名のみ）でもワイルドカード検索（Danbooruは苗字を落として
 *      名のみ+作品名カッコにすることが多いため。例: asuna_ichinose→asuna_(blue_archive)）
 *   7. どれも見つからなければ tag=null（このキャラは Danbooru 尤度なし。
 *      16軸ソースのみで参加する）
 *
 * 全件 category=4 かつ post_count>0 を要求する。加えて data/supply.json の
 * hitomi.galleryCount と桁比較し、比が50倍を超える/下回る場合は要レビューにフラグする
 * （誤タグ対応の早期発見。PLAN「タグ誤対応」リスク対策）。
 *
 * 再実行時は checkedAt が7日以内のエントリをスキップする（--force で無視、
 * --char <id> で単体のみ強制再チェック）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  countPosts,
  createDanbooruFetcher,
  fetchTagExact,
  searchCharacterTagCandidates,
} from './danbooru-client.mjs';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
/** post_count比がこの範囲を外れたら要レビューにする（誤タグ対応の早期検出）。 */
const SANITY_RATIO_MAX = 50;
/** copyrightタグとの共起率がこれ未満なら「別シリーズの同名キャラの疑い」とする。 */
const SERIES_OVERLAP_MIN = 0.3;
/** 共起率がこれを超えたら十分に確からしいとみなし、以降の候補チェックを打ち切る。 */
const SERIES_OVERLAP_CONFIDENT = 0.7;
/**
 * Fateは stay_night/apocrypha/kaleid_liner_prisma_illya/grand_order 等に作品タグが
 * 分裂しているが、FGOクロスオーバーで人気が出たキャラは自身の出自作品タグより
 * fate_(series)（傘タグ）との方が共起率が高いことがある。特定作品エイリアスの
 * 共起率が低くても傘タグとの共起率が高ければそちらを採用する（2026-07-24、
 * アストルフォがFate/Apocrypha側で46%止まりのため無関係の675件タグに誤対応、
 * イリヤも同様にFate/stay night側で本来の10981件タグを見送っていた実例で発覚）。
 */
const FATE_UMBRELLA_ALIAS = 'fate_(series)';

export function toBareTag(hitomiCharacter) {
  return hitomiCharacter.trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * タグ名の曖昧回避カッコ表記（例: `taihou_(kancolle)`）はcopyrightタグの正式名
 * （`kantai_collection`）と文字列が一致しないことがあるため、名前の一致ではなく
 * 実際のタグ共起（`countPosts`の積集合 ÷ 候補タグ自身の件数）で検証する
 * （2026-07-22、大鳳が`taihou_(azur_lane)`に誤対応した実例で発覚。文字列一致だけの
 * 判定は「最重要リスク」に対して不十分だった）。
 * @param {ReturnType<typeof createDanbooruFetcher>} danbooruFetch
 * @param {{name: string, post_count: number}} tag
 * @param {string | null} seriesAlias
 * @param {string | null} [fallbackAlias] 主エイリアスの共起率が低くても、こちらとの
 *   共起率が高ければそちらを採用する（Fateの傘タグ用）。
 * @returns {Promise<number | null>} 共起率（主・fallback高い方）。seriesAlias が
 *   無ければ検証できないので null
 */
export async function seriesOverlapRatio(danbooruFetch, tag, seriesAlias, fallbackAlias = null) {
  if (!seriesAlias) return null;
  const intersection = await countPosts(danbooruFetch, [tag.name, seriesAlias]);
  const primary = intersection / tag.post_count;
  if (!fallbackAlias || fallbackAlias === seriesAlias) return primary;
  const fallbackIntersection = await countPosts(danbooruFetch, [tag.name, fallbackAlias]);
  return Math.max(primary, fallbackIntersection / tag.post_count);
}

/**
 * @param {ReturnType<typeof createDanbooruFetcher>} danbooruFetch
 * @param {Pick<import('../../src/data/schema.ts').Character, 'id' | 'series' | 'hitomiQuery'>} character
 *   実際に使うのは id・series・hitomiQuery.character の3値のみ（他のCharacterフィールドは不要）。
 * @param {{ overrides: Record<string, {tag: string|null, reason?: string}>, seriesAliases: Record<string,string> }} overridesFile
 */
export async function mapOneCharacter(danbooruFetch, character, overridesFile) {
  const checkedAt = () => new Date().toISOString();
  const override = overridesFile.overrides[character.id];
  if (override) {
    if (override.tag === null) {
      return { tag: null, reason: override.reason ?? 'override-excluded', source: 'override', checkedAt: checkedAt() };
    }
    const tag = await fetchTagExact(danbooruFetch, override.tag);
    if (!tag || tag.category !== 4 || tag.post_count === 0) {
      return { tag: null, reason: `override先「${override.tag}」が無効/0件`, source: 'override', checkedAt: checkedAt() };
    }
    // overrideは手書きで確定済みという扱いなので共起検証はスキップする。
    return { tag: tag.name, postCount: tag.post_count, source: 'override', checkedAt: checkedAt() };
  }

  const seriesAlias = overridesFile.seriesAliases[character.series] ?? null;
  const fateFallbackAlias =
    seriesAlias && seriesAlias.startsWith('fate') && seriesAlias !== FATE_UMBRELLA_ALIAS
      ? FATE_UMBRELLA_ALIAS
      : null;
  const base = toBareTag(character.hitomiQuery.character);
  const candidatesTried = [base];

  // bare一致・series-qualified一致・ワイルドカード候補を、投稿数降順の1本の候補列にする。
  /** @type {{name: string, category: number, post_count: number, via: string}[]} */
  const candidates = [];

  const bare = await fetchTagExact(danbooruFetch, base);
  const bareValid = bare !== null && bare.category === 4 && bare.post_count > 0;
  if (bareValid) candidates.push({ ...bare, via: 'exact' });

  // hitomi側は西洋語順(名→姓)のことがあるが、Danbooruは日本語語順(姓→名)の
  // タグを正式名にすることがある（例: 「teto kasane」→ 実際は kasane_teto）。
  // bareが「タグとして存在はするが category≠4 or 0件」（廃止済みwikiリダイレクト等）の
  // ケースもあるため、null判定ではなく「有効な候補が無い」で判定する
  // （2026-07-22、utau-tetoの teto_kasane が category=0・0件で存在していたため発覚）。
  // ちょうど2語のときだけ反転も試す。
  const parts = base.split('_');
  if (!bareValid && parts.length === 2) {
    const reversed = `${parts[1]}_${parts[0]}`;
    candidatesTried.push(reversed);
    const reversedTag = await fetchTagExact(danbooruFetch, reversed);
    if (reversedTag && reversedTag.category === 4 && reversedTag.post_count > 0) {
      candidates.push({ ...reversedTag, via: 'name-order-reversed' });
    }
  }

  if (seriesAlias) {
    const qualifiedName = `${base}_(${seriesAlias})`;
    candidatesTried.push(qualifiedName);
    const qualifiedTag = await fetchTagExact(danbooruFetch, qualifiedName);
    if (qualifiedTag && qualifiedTag.category === 4 && qualifiedTag.post_count > 0) {
      candidates.push({ ...qualifiedTag, via: 'series-qualified' });
    }
  }

  candidatesTried.push(`${base}(*)`);
  const wildcard = await searchCharacterTagCandidates(danbooruFetch, base);
  for (const t of wildcard.filter((c) => c.category === 4 && c.post_count > 0)) {
    if (!candidates.some((c) => c.name === t.name)) candidates.push({ ...t, via: 'wildcard' });
  }

  // Danbooruは苗字を落とし名のみ+作品名カッコで character タグにすることが多い
  // （例: hitomi「asuna ichinose」→ 実際は asuna_(blue_archive)、苗字ichinoseは
  // タグに一切現れない）。2語以上のときは先頭語だけでもワイルドカード検索する
  // （2026-07-24、Blue Archive全8体+ジェネシン/レビ・アッカーマン等13体がこの
  // パターンでnot-foundだったため発覚。共起検証は既存候補と同じ関門を通す）。
  if (parts.length > 1) {
    candidatesTried.push(`${parts[0]}(*)`);
    const firstWordWildcard = await searchCharacterTagCandidates(danbooruFetch, parts[0]);
    for (const t of firstWordWildcard.filter((c) => c.category === 4 && c.post_count > 0)) {
      if (!candidates.some((c) => c.name === t.name)) candidates.push({ ...t, via: 'wildcard' });
    }
  }

  // exact/反転/series修飾は名前そのものを狙い撃ちした照合なので、post_countの大小に
  // 関係なく最優先で確認する。ワイルドカード由来はその次に投稿数降順で並べる
  // （2026-07-24、overlord-yuriの実例で発覚: 正解の yuri_alpha は76件しかなく、他作品の
  // 同名キャラ(DDLC/テイルズ/KOF等、数百〜千件超)にpost_count降順の上位5枠を奪われ
  // 一度も共起率チェックすら受けられなかった）。
  const WILDCARD_PRIORITY = 1;
  const TARGETED_PRIORITY = 0;
  candidates.sort((a, b) => {
    const pa = a.via === 'wildcard' ? WILDCARD_PRIORITY : TARGETED_PRIORITY;
    const pb = b.via === 'wildcard' ? WILDCARD_PRIORITY : TARGETED_PRIORITY;
    if (pa !== pb) return pa - pb;
    return b.post_count - a.post_count;
  });

  if (candidates.length === 0) {
    return { tag: null, reason: 'not-found', source: 'not-found', candidatesTried, checkedAt: checkedAt() };
  }

  // 上の優先順のまま先頭から、copyrightタグとの共起率を確認して最初に「確からしい」
  // 候補を採用する。seriesAlias が無い場合は共起検証できないので先頭をそのまま採用する。
  let bestSoFar = null;
  for (const cand of candidates.slice(0, 5)) {
    const overlap = await seriesOverlapRatio(danbooruFetch, cand, seriesAlias, fateFallbackAlias);
    if (overlap === null) {
      bestSoFar = { ...cand, overlap: null };
      break;
    }
    if (bestSoFar === null || overlap > bestSoFar.overlap) bestSoFar = { ...cand, overlap };
    if (overlap >= SERIES_OVERLAP_CONFIDENT) break;
  }

  const source =
    bestSoFar.overlap === null
      ? bestSoFar.via
      : bestSoFar.overlap < SERIES_OVERLAP_MIN
        ? 'low-overlap'
        : bestSoFar.via === 'wildcard'
          ? 'wildcard-verified'
          : bestSoFar.via;

  return {
    tag: bestSoFar.name,
    postCount: bestSoFar.post_count,
    source,
    seriesOverlap: bestSoFar.overlap,
    candidatesTried,
    allCandidates: candidates.slice(0, 5).map((t) => `${t.name}(${t.post_count})`),
    checkedAt: checkedAt(),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const charFilter = args.includes('--char') ? args[args.indexOf('--char') + 1] : null;

  const dataDir = new URL('../../data/', import.meta.url);
  const charactersPath = fileURLToPath(new URL('characters.json', dataDir));
  const supplyPath = fileURLToPath(new URL('supply.json', dataDir));
  const overridesPath = fileURLToPath(new URL('bayes/tag-overrides.json', dataDir));
  const tagMapPath = fileURLToPath(new URL('bayes/tag-map.json', dataDir));

  const characters = JSON.parse(readFileSync(charactersPath, 'utf8'));
  const supply = JSON.parse(readFileSync(supplyPath, 'utf8'));
  const overridesFile = JSON.parse(readFileSync(overridesPath, 'utf8'));

  let tagMap = { version: 1, entries: {} };
  try {
    tagMap = JSON.parse(readFileSync(tagMapPath, 'utf8'));
  } catch (_err) {
    // 初回実行。空のtagMapで開始する。
  }

  const targets = charFilter ? characters.filter((c) => c.id === charFilter) : characters;
  if (charFilter && targets.length === 0) {
    console.error(`指定されたキャラid「${charFilter}」が見つかりません。`);
    process.exitCode = 1;
    return;
  }

  // seriesAlias が無いと seriesOverlapRatio() が検証をスキップし（null を返す）、
  // ワイルドカードの誤ヒットがそのまま採用される。2026-08-01 にこれで5件の誤対応が
  // 出荷された（符玄→fujiwara_no_mokou 等）。実行してから気づくのでは遅いので先に止める。
  // 最終的なゲートは tests/bayes-data.test.ts の BA5。
  const seriesWithoutAlias = [...new Set(targets.map((c) => c.series))]
    .filter((s) => !(s in overridesFile.seriesAliases))
    .sort();
  if (seriesWithoutAlias.length > 0) {
    console.error('');
    console.error('[ERROR] seriesAliases に未定義の作品があります:');
    for (const s of seriesWithoutAlias) console.error(`     ${s}`);
    console.error('');
    console.error('   このまま実行すると作品タグとの共起検証がスキップされ、');
    console.error('   別作品の同名キャラを誤って採用しても検出できません。');
    console.error('   data/bayes/tag-overrides.json の seriesAliases に');
    console.error('   Danbooru の category=3(著作権)タグを追加してから再実行してください。');
    console.error('');
    process.exitCode = 1;
    return;
  }

  const now = Date.now();
  const pending = targets.filter((c) => {
    if (force || charFilter) return true;
    const existing = tagMap.entries[c.id];
    if (!existing) return true;
    return now - new Date(existing.checkedAt).getTime() > SEVEN_DAYS_MS;
  });

  if (pending.length === 0) {
    console.log('全キャラ、7日以内にチェック済みです（--force で再チェック）。');
    return;
  }
  console.log(`Danbooruタグ導出対象 ${pending.length} 件`);

  const danbooruFetch = createDanbooruFetcher({});
  const needsReview = [];

  for (const [index, character] of pending.entries()) {
    process.stdout.write(`[${index + 1}/${pending.length}] ${character.name} (${character.id}) ... `);
    const result = await mapOneCharacter(danbooruFetch, character, overridesFile);
    tagMap.entries[character.id] = result;
    writeFileSync(tagMapPath, `${JSON.stringify(tagMap, null, 2)}\n`);

    if (result.tag === null) {
      console.log(`見つからず (${result.reason})`);
      needsReview.push({ id: character.id, name: character.name, issue: result.reason });
      continue;
    }

    const hitomiCount = supply[character.id]?.hitomi?.galleryCount;
    let sanityNote = '';
    if (typeof hitomiCount === 'number' && hitomiCount > 0 && result.postCount > 0) {
      const ratio = result.postCount / hitomiCount;
      if (ratio > SANITY_RATIO_MAX || ratio < 1 / SANITY_RATIO_MAX) {
        sanityNote = ` [要レビュー: hitomi=${hitomiCount}件との比が${ratio.toFixed(1)}倍]`;
        needsReview.push({ id: character.id, name: character.name, issue: `件数比異常(danbooru=${result.postCount}, hitomi=${hitomiCount}, 比=${ratio.toFixed(1)})` });
      }
    }
    if (result.source === 'low-overlap') {
      needsReview.push({
        id: character.id,
        name: character.name,
        issue: `シリーズ共起率が低い(${(result.seriesOverlap * 100).toFixed(0)}%、別シリーズ同名キャラの疑い)。候補: ${result.allCandidates.join(', ')}`,
      });
    } else if (result.source === 'wildcard-verified') {
      needsReview.push({
        id: character.id,
        name: character.name,
        issue: `曖昧だったが共起検証で採用（共起率${(result.seriesOverlap * 100).toFixed(0)}%）: ${result.tag}。候補: ${result.allCandidates.join(', ')}`,
      });
    }
    const overlapNote = result.seriesOverlap !== null && result.seriesOverlap !== undefined ? `, 共起率${(result.seriesOverlap * 100).toFixed(0)}%` : '';
    console.log(`${result.tag} (${result.postCount}件, ${result.source}${overlapNote})${sanityNote}`);
  }

  console.log(`\n完了。${pending.length} 件を data/bayes/tag-map.json に書き込みました。`);
  if (needsReview.length > 0) {
    console.log(`\n=== 要レビュー ${needsReview.length} 件 ===`);
    for (const r of needsReview) {
      console.log(`  ${r.id} (${r.name}): ${r.issue}`);
    }
    console.log('\nこれらは data/bayes/tag-overrides.json の overrides に手書きで確定させてください。');
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
