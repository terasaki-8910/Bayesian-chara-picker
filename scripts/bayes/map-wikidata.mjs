#!/usr/bin/env node
/**
 * data/characters.json の全キャラについて、対応するWikidataのQIDを導出・検証し、
 * data/bayes/wikidata-map.json（監査証跡）と data/bayes/wikidata-facts.json
 * （実際にbuild-likelihoods.mjsが読む制御値）へ書き出す（PLAN「P5a」）。
 *
 * 導出の優先順位:
 *   1. data/bayes/wikidata-overrides.json の overrides[id]（手書き強制指定・除外）
 *   2. character.name（日本語表記）で wbsearchentities 検索
 *   3. 候補ごとに P1441(登場する作品) を解決し、data/bayes/tag-overrides.json の
 *      seriesAliases（Danbooru用に既に手検証済みの英語シリーズ名）と緩い部分一致で
 *      照合する（二重管理を避けるため series 別名表はここでは再利用のみ）
 *   4. 一致する候補が無ければ tag=null（このキャラはWikidata尤度なし）
 *
 * 抽出する事実（P31は多値かつ非一貫であることを実地確認済み。2026-07-25）:
 *   - P21(性別) → genderExpression（女性/男性のみ対応。他は要レビュー）
 *   - P1884(髪色)/P1340(目の色) → wikidata-overrides.json の
 *     hairColorMap/eyeColorMap で解決。未知QIDはnullのまま要レビューに出す
 *     （誤った色を掴むよりも「寄与なし」の方が安全）
 *   - P31(分類上の性質、配列) に humanQids のいずれかが含まれるかだけを見る
 *     （「人間と確認できた」という正信号のみ。不在は「人間でない」の根拠にしない
 *     ——博麗霊夢はP31に4値持ちQ15632617を含むが、一之瀬アスナは
 *     'video game character'のみでQ15632617を持たない。後者は単に
 *     Wikidata側の分類が手薄なだけで人間でないわけではないため）
 *
 * 再実行時は checkedAt が7日以内のエントリをスキップする（--force で無視、
 * --char <id> で単体のみ強制再チェック）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claimValuesOf, createWikidataFetcher, fetchEntity, fetchEntityLabels, searchEntity } from './wikidata-client.mjs';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SEARCH_CANDIDATES = 5;

/** genderExpressionのenumに写像できるWikidataの性別QID。それ以外は要レビュー。 */
const GENDER_QID_MAP = {
  Q6581072: '女性', // female
  Q6581097: '男性', // male
};

function normalizeForMatch(s) {
  return s
    .toLowerCase()
    .replace(/[_\-:!?！？・、。'’]/g, '')
    .replace(/\s+/g, '');
}

function looseMatch(a, b) {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (na.length === 0 || nb.length === 0) return false;
  return na.includes(nb) || nb.includes(na);
}

/**
 * 候補のP1441(登場する作品)ラベルが、このキャラのシリーズ名と緩く一致するか。
 * ja/en両方のラベルを、シリーズ名の日本語表記(character.series)とDanbooru向け
 * 英語別名(seriesAlias)の両方に対して照合する——Wikidataのエンティティは
 * 片方の言語ラベルしか持たないことがある（2026-07-25、原神の作品エンティティが
 * jaラベルのみ・en無しだったため、en固定の照合だと本来一致するはずの
 * genshin-ayakaが偽陰性でlow-confidence判定になっていた実例で発覚）。
 * @param {{ ja: string, en: string }} workLabel
 * @param {string} seriesJa character.series（日本語）
 * @param {string | null} seriesAlias tag-overrides.json由来の英語シリーズ名（アンダースコア区切り）
 * @returns {boolean}
 */
function seriesLabelMatches(workLabel, seriesJa, seriesAlias) {
  if (workLabel.ja && looseMatch(workLabel.ja, seriesJa)) return true;
  if (seriesAlias && workLabel.en && looseMatch(workLabel.en, seriesAlias.replace(/_/g, ' ').replace(/\(.*\)/, ''))) return true;
  return false;
}

/**
 * @param {ReturnType<typeof createWikidataFetcher>} wikidataFetch
 * @param {Pick<import('../../src/data/schema.ts').Character, 'id' | 'name' | 'series'>} character
 * @param {{ overrides: Record<string, {qid: string|null, reason?: string}>, humanQids: string[], hairColorMap: Record<string,string|null>, eyeColorMap: Record<string,string|null> }} overridesFile
 * @param {Record<string,string>} seriesAliases tag-overrides.json由来
 */
async function mapOneCharacter(wikidataFetch, character, overridesFile, seriesAliases) {
  const checkedAt = () => new Date().toISOString();
  const override = overridesFile.overrides[character.id];
  if (override) {
    if (override.qid === null) {
      return { qid: null, reason: override.reason ?? 'override-excluded', source: 'override', checkedAt: checkedAt() };
    }
    const entity = await fetchEntity(wikidataFetch, override.qid);
    return { qid: override.qid, label: entity.labels?.ja?.value ?? entity.labels?.en?.value ?? '', source: 'override', checkedAt: checkedAt() };
  }

  const seriesAlias = seriesAliases[character.series] ?? null;
  const candidates = await searchEntity(wikidataFetch, character.name, SEARCH_CANDIDATES);
  if (candidates.length === 0) {
    return { qid: null, reason: 'not-found', source: 'not-found', checkedAt: checkedAt() };
  }

  let best = null;
  for (const cand of candidates) {
    const entity = await fetchEntity(wikidataFetch, cand.id);
    const workRefs = claimValuesOf(entity, 'P1441')
      .filter((v) => v.type === 'wikibase-entityid')
      .map((v) => /** @type {{ id: string }} */ (v.value).id);
    if (workRefs.length === 0) {
      if (best === null) best = { entity, cand, seriesMatch: false };
      continue;
    }
    const workLabels = await fetchEntityLabels(wikidataFetch, workRefs);
    const matched = workRefs.some((qid) => seriesLabelMatches(workLabels[qid], character.series, seriesAlias));
    if (matched) {
      best = { entity, cand, seriesMatch: true };
      break;
    }
    if (best === null || best.seriesMatch === false) best = { entity, cand, seriesMatch: false };
  }

  // シリーズ一致を確認できなかった候補は既定で除外する（qid/labelはwikidata-map.json
  // に記録し人間レビュー・overrides行きにするが、factsは抽出しない）。艦これ/Fateの
  // 実在史実由来キャラは、Wikidata検索が同名の実在の艦船・歴史上人物のエンティティを
  // 先に返し、フィクションキャラ自身のエンティティが候補にすら現れないことがある
  // （2026-07-25、「加賀」検索で上位8件が全て実在の艦船・地名・史実人物だった実例で
  // 確認）。Danbooruのタグ誤対応（同じキャラの別シリーズ変種）とは違い、こちらは
  // 「全く無関係な実在エンティティ」の恐れがあるため、確認できない限り安全側に倒す。
  if (!best.seriesMatch) {
    return {
      qid: null,
      reason: `シリーズ確認不能のため除外(候補qid=${best.cand.id}, ${best.cand.label})。要レビュー→確認できればoverridesへ。`,
      source: 'low-confidence',
      candidateQid: best.cand.id,
      candidateLabel: best.cand.label,
      checkedAt: checkedAt(),
    };
  }

  return {
    qid: best.cand.id,
    label: best.cand.label,
    source: 'search-verified',
    seriesMatch: true,
    checkedAt: checkedAt(),
  };
}

/** P2048(身長)のquantity値で受け付ける単位QIDと、cmへの換算係数。 */
const HEIGHT_UNIT_TO_CM = {
  Q174728: 1, // センチメートル
  Q11573: 100, // メートル
  Q3710: 30.48, // フィート
};

/**
 * P2048のquantity値をcmへ正規化する。未対応の単位はnull（誤った身長を掴むより
 * 「寄与なし」の方が安全、という色QIDと同じ方針）。
 * @param {{ amount: string, unit: string }} value
 * @returns {number | null}
 */
function heightToCm(value) {
  // unitは "http://www.wikidata.org/entity/Q174728" 形式のURI。
  const unitQid = String(value.unit ?? '').split('/').pop() ?? '';
  const factor = HEIGHT_UNIT_TO_CM[unitQid];
  if (factor === undefined) return null;
  const amount = Number(value.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount * factor;
}

/**
 * 身長(cm)を stature 軸の3値へバケット分けする。しきい値は
 * data/bayes/wikidata-overrides.json の statureThresholds（手書きの正本。
 * 色QIDの対応表と同じく「実データを見てから決める」運用）。
 * @param {number} cm
 * @param {{ petiteMaxCm: number, tallMinCm: number }} thresholds
 * @returns {'小柄' | '標準' | '長身'}
 */
function statureBucketOf(cm, thresholds) {
  if (cm <= thresholds.petiteMaxCm) return '小柄';
  if (cm >= thresholds.tallMinCm) return '長身';
  return '標準';
}

/**
 * @param {import('./wikidata-client.mjs').WikidataEntity} entity
 * @param {{ humanQids: string[], hairColorMap: Record<string,string|null>, eyeColorMap: Record<string,string|null>, statureThresholds: { petiteMaxCm: number, tallMinCm: number } }} overridesFile
 */
function extractFacts(entity, overridesFile) {
  const facts = {};
  const notes = [];

  const genderValues = claimValuesOf(entity, 'P21').filter((v) => v.type === 'wikibase-entityid');
  if (genderValues.length > 0) {
    const qid = /** @type {{ id: string }} */ (genderValues[0].value).id;
    const mapped = GENDER_QID_MAP[qid];
    if (mapped) facts.genderExpression = mapped;
    else notes.push(`未対応の性別QID: ${qid}`);
  }

  const hairValues = claimValuesOf(entity, 'P1884').filter((v) => v.type === 'wikibase-entityid');
  if (hairValues.length > 0) {
    const qid = /** @type {{ id: string }} */ (hairValues[0].value).id;
    if (qid in overridesFile.hairColorMap) {
      const mapped = overridesFile.hairColorMap[qid];
      if (mapped) facts.hairColor = mapped;
      else notes.push(`hairColorMapに保留登録済み・未確定のQID: ${qid}`);
    } else {
      notes.push(`未知の髪色QID: ${qid}`);
    }
  }

  const eyeValues = claimValuesOf(entity, 'P1340').filter((v) => v.type === 'wikibase-entityid');
  if (eyeValues.length > 0) {
    const qid = /** @type {{ id: string }} */ (eyeValues[0].value).id;
    if (qid in overridesFile.eyeColorMap) {
      const mapped = overridesFile.eyeColorMap[qid];
      if (mapped) facts.eyeColor = mapped;
      else notes.push(`eyeColorMapに保留登録済み・未確定のQID: ${qid}`);
    } else {
      notes.push(`未知の目の色QID: ${qid}`);
    }
  }

  const heightValues = claimValuesOf(entity, 'P2048').filter((v) => v.type === 'quantity');
  if (heightValues.length > 0) {
    const raw = /** @type {{ amount: string, unit: string }} */ (heightValues[0].value);
    const cm = heightToCm(raw);
    if (cm === null) notes.push(`未対応の身長の単位/値: ${JSON.stringify(raw)}`);
    else facts.stature = statureBucketOf(cm, overridesFile.statureThresholds);
  }

  const instanceOfQids = claimValuesOf(entity, 'P31')
    .filter((v) => v.type === 'wikibase-entityid')
    .map((v) => /** @type {{ id: string }} */ (v.value).id);
  if (instanceOfQids.some((qid) => overridesFile.humanQids.includes(qid))) {
    // 配列にする——questions.jsonのspecies=人間ソースはmulti:trueで
    // estimateWikidataLikelihoodの「配列にincludesすれば正信号、それ以外はnull」
    // 経路を使う（単一値だと不一致時にWIKIDATA_LIKELY_NOという負信号が出てしまい、
    // 「P31にQ15632617が無い＝人間でない」という誤った推論になるため。
    // PLAN「species版差問題」参照）。
    facts.species = ['人間'];
  }

  return { facts, notes };
}

/**
 * ネットワークを一切使わず、キャッシュ済みの生エンティティから facts だけを
 * 再抽出する（--from-cache）。色QIDの対応表やstatureのしきい値のような
 * 「手書きの写像規則」を調整するたびに全件を再取得するのは無駄が大きく、
 * かつ相手サーバへの負荷でもあるため（2026-08-01、statureのしきい値を
 * 実データの分布を見てから決めたかったが、P5計画に書かれていた生エンティティの
 * キャッシュが実際には実装されておらず再取得が必要だったことから追加）。
 */
function reextractFromCache({ characters, overridesFile, cacheDir, factsPath, wikidataFacts, charFilter }) {
  const targets = charFilter ? characters.filter((c) => c.id === charFilter) : characters;
  const needsReview = [];
  let updated = 0;
  let missing = 0;

  for (const character of targets) {
    const cachePath = join(cacheDir, `${character.id}.json`);
    let cached;
    try {
      cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    } catch (_err) {
      missing += 1;
      continue;
    }
    const { facts, notes } = extractFacts(cached.entity, overridesFile);

    // ネットワーク版と同じ性別サニティチェックを通す（片方だけ緩いと、
    // --from-cache で再抽出した瞬間に誤対応のfactsが復活してしまう）。
    const reviewedGender = character.axes?.genderExpression;
    if (facts.genderExpression && reviewedGender && facts.genderExpression !== reviewedGender) {
      wikidataFacts.entries[character.id] = {};
      needsReview.push({ id: character.id, name: character.name, issue: `性別不一致で無効化（--from-cache）` });
      continue;
    }

    wikidataFacts.entries[character.id] = facts;
    updated += 1;
    for (const note of notes) needsReview.push({ id: character.id, name: character.name, issue: note });
  }

  writeFileSync(factsPath, `${JSON.stringify(wikidataFacts, null, 2)}\n`);
  console.log(`キャッシュから ${updated} 件のfactsを再抽出しました（キャッシュ無し ${missing} 件）。`);
  if (needsReview.length > 0) {
    console.log(`\n=== 要レビュー ${needsReview.length} 件 ===`);
    for (const r of needsReview) console.log(`  ${r.id} (${r.name}): ${r.issue}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const fromCache = args.includes('--from-cache');
  const charFilter = args.includes('--char') ? args[args.indexOf('--char') + 1] : null;

  const dataDir = new URL('../../data/', import.meta.url);
  const charactersPath = fileURLToPath(new URL('characters.json', dataDir));
  const tagOverridesPath = fileURLToPath(new URL('bayes/tag-overrides.json', dataDir));
  const overridesPath = fileURLToPath(new URL('bayes/wikidata-overrides.json', dataDir));
  const mapPath = fileURLToPath(new URL('bayes/wikidata-map.json', dataDir));
  const factsPath = fileURLToPath(new URL('bayes/wikidata-facts.json', dataDir));
  const cacheDir = fileURLToPath(new URL('../../state/bayes-pipeline/wikidata/', import.meta.url));

  const characters = JSON.parse(readFileSync(charactersPath, 'utf8'));
  const tagOverrides = JSON.parse(readFileSync(tagOverridesPath, 'utf8'));
  const overridesFile = JSON.parse(readFileSync(overridesPath, 'utf8'));

  let wikidataMap = { version: 1, entries: {} };
  try {
    wikidataMap = JSON.parse(readFileSync(mapPath, 'utf8'));
  } catch (_err) {
    // 初回実行。
  }
  let wikidataFacts = { version: 1, entries: {} };
  try {
    wikidataFacts = JSON.parse(readFileSync(factsPath, 'utf8'));
  } catch (_err) {
    // 初回実行。
  }

  const targets = charFilter ? characters.filter((c) => c.id === charFilter) : characters;
  if (charFilter && targets.length === 0) {
    console.error(`指定されたキャラid「${charFilter}」が見つかりません。`);
    process.exitCode = 1;
    return;
  }

  if (fromCache) {
    reextractFromCache({ characters, overridesFile, cacheDir, factsPath, wikidataFacts, charFilter });
    return;
  }

  mkdirSync(cacheDir, { recursive: true });

  const now = Date.now();
  const pending = targets.filter((c) => {
    if (force || charFilter) return true;
    const existing = wikidataMap.entries[c.id];
    if (!existing) return true;
    return now - new Date(existing.checkedAt).getTime() > SEVEN_DAYS_MS;
  });

  if (pending.length === 0) {
    console.log('全キャラ、7日以内にチェック済みです（--force で再チェック）。');
    return;
  }
  console.log(`Wikidata QID導出対象 ${pending.length} 件`);

  const wikidataFetch = createWikidataFetcher({});
  const needsReview = [];

  for (const [index, character] of pending.entries()) {
    process.stdout.write(`[${index + 1}/${pending.length}] ${character.name} (${character.id}) ... `);
    const result = await mapOneCharacter(wikidataFetch, character, overridesFile, tagOverrides.seriesAliases);
    wikidataMap.entries[character.id] = result;
    writeFileSync(mapPath, `${JSON.stringify(wikidataMap, null, 2)}\n`);

    if (result.qid === null) {
      console.log(`見つからず (${result.reason})`);
      needsReview.push({ id: character.id, name: character.name, issue: result.reason });
      wikidataFacts.entries[character.id] = {};
      writeFileSync(factsPath, `${JSON.stringify(wikidataFacts, null, 2)}\n`);
      continue;
    }

    const entity = await fetchEntity(wikidataFetch, result.qid);
    // 生エンティティをキャッシュする（gitignore対象）。写像規則（色QIDの対応表・
    // statureのしきい値など）を変えたときに --from-cache で再取得なしに
    // factsだけを作り直せるようにするため。
    writeFileSync(
      join(cacheDir, `${character.id}.json`),
      `${JSON.stringify({ qid: result.qid, entity, fetchedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    const { facts, notes } = extractFacts(entity, overridesFile);

    // サニティチェック: 抽出したgenderExpressionが本プロジェクト自身の査読済み
    // characters.jsonの値と食い違うなら、QID自体が別人物/別キャラの誤対応である
    // 強い兆候とみなし、この候補のfacts全体を無効化する（2026-07-25、
    // azurlane-nagatoがgenderExpression=男性という明らかな誤りを返した実例で発覚
    // ——他の事実(hairColor等)も同じ誤ったエンティティ由来なので道連れで捨てる）。
    const reviewedGender = character.axes?.genderExpression;
    if (facts.genderExpression && reviewedGender && facts.genderExpression !== reviewedGender) {
      needsReview.push({
        id: character.id,
        name: character.name,
        issue: `性別不一致で無効化: Wikidata=${facts.genderExpression} vs 査読済み=${reviewedGender} (qid=${result.qid}, ${result.label})。誤対応の疑いが強いためfacts全体を破棄。`,
      });
      wikidataFacts.entries[character.id] = {};
      writeFileSync(factsPath, `${JSON.stringify(wikidataFacts, null, 2)}\n`);
      console.log(`${result.qid} (${result.label ?? ''}) 性別不一致のため破棄`);
      continue;
    }

    wikidataFacts.entries[character.id] = facts;
    writeFileSync(factsPath, `${JSON.stringify(wikidataFacts, null, 2)}\n`);

    if (result.source === 'low-confidence' || result.source === 'search-unverifiable') {
      needsReview.push({ id: character.id, name: character.name, issue: `${result.source}: qid=${result.qid} (${result.label})` });
    }
    for (const note of notes) {
      needsReview.push({ id: character.id, name: character.name, issue: note });
    }

    console.log(`${result.qid} (${result.label ?? ''}, ${result.source}) facts=${JSON.stringify(facts)}`);
  }

  console.log(`\n完了。${pending.length} 件を data/bayes/wikidata-map.json / wikidata-facts.json に書き込みました。`);
  if (needsReview.length > 0) {
    console.log(`\n=== 要レビュー ${needsReview.length} 件 ===`);
    for (const r of needsReview) {
      console.log(`  ${r.id} (${r.name}): ${r.issue}`);
    }
    console.log('\nQIDの誤りは data/bayes/wikidata-overrides.json の overrides、色QIDの未対応は hairColorMap/eyeColorMap に手書きで追記してください。');
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
