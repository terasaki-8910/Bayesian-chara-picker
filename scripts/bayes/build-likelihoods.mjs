#!/usr/bin/env node
/**
 * data/bayes/questions.json（手書き正本）+ data/bayes/tag-map.json +
 * state/bayes-pipeline/danbooru/<id>.json（sample-posts.mjsのキャッシュ）+
 * data/characters.json の16軸データから、キャラ×質問の尤度密行列を機械構築する。
 * 通信は一切しない・決定論（同じ入力から常に同じ出力）。
 *
 * 出力:
 *   data/bayes/likelihoods.json      キャラ×質問 P(yes|c) 密行列（数値のみ）
 *   data/bayes/questions.runtime.json UI用射影（日本語プロンプトのみ。タグ文字列・sourcesは含めない）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_EPSILON,
  AXIS_MERGE_WEIGHT,
  WIKIDATA_MERGE_WEIGHT,
  clamp01,
  computeBinaryTheta,
  computeGroupBaseRate,
  estimateAxisMultiLikelihood,
  estimateAxisSingleLikelihood,
  estimateBinaryLikelihood,
  estimateBinaryRawRate,
  estimateGroupLikelihood,
  estimateWikidataLikelihood,
  mergeLikelihoods,
} from './estimators.mjs';

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/** 投稿配列から「いずれかのタグを含む投稿数(n_G)」と「タグ別内訳(k_q)」を数える。 */
function countGroupCoverage(posts, coverageTags) {
  const tagSet = new Set(coverageTags);
  let nG = 0;
  const kByTag = Object.fromEntries(coverageTags.map((t) => [t, 0]));
  for (const post of posts) {
    let matched = false;
    for (const t of post.tags) {
      if (kByTag[t] !== undefined) {
        kByTag[t] += 1;
        matched = true;
      } else if (tagSet.has(t)) {
        matched = true;
      }
    }
    if (matched) nG += 1;
  }
  return { nG, kByTag };
}

function countBinary(posts, tag) {
  let k = 0;
  for (const post of posts) {
    if (post.tags.includes(tag)) k += 1;
  }
  return k;
}

function loadDanbooruCache(cacheDir, id) {
  try {
    const data = JSON.parse(readFileSync(fileURLToPath(new URL(`${id}.json`, cacheDir)), 'utf8'));
    return data.posts;
  } catch (_err) {
    return []; // タグ未対応キャラ(azurlane-yamato等)。0件=n_eff0として自然にaxisのみへフォールバックする。
  }
}

function axisSourceLikelihood(character, source) {
  const raw = character.axes[source.axis];
  return source.multi
    ? estimateAxisMultiLikelihood(raw, source.value)
    : estimateAxisSingleLikelihood(raw, source.value);
}

/**
 * wikidata-facts.json は16軸(schema.tsのAxes)に無いキー（eyeColor等）も持つため
 * character.axesではなく専用のfactsオブジェクトから引く（PLAN「P5」）。
 */
function wikidataSourceLikelihood(facts, source) {
  const value = facts?.[source.axis];
  return estimateWikidataLikelihood({ value, target: source.value, multi: source.multi });
}

async function main() {
  const dataDir = new URL('../../data/', import.meta.url);
  const cacheDir = new URL('../../state/bayes-pipeline/danbooru/', import.meta.url);
  const characters = JSON.parse(readFileSync(fileURLToPath(new URL('characters.json', dataDir)), 'utf8'));
  const questionsFile = JSON.parse(readFileSync(fileURLToPath(new URL('bayes/questions.json', dataDir)), 'utf8'));
  const tagMap = JSON.parse(readFileSync(fileURLToPath(new URL('bayes/tag-map.json', dataDir)), 'utf8'));
  // wikidata-facts.json は任意（P5a未実行時は{}扱い。Danbooruキャッシュ欠落と同じく
  // 自然にnull寄与へフォールバックする）。
  let wikidataFacts = { entries: {} };
  try {
    wikidataFacts = JSON.parse(readFileSync(fileURLToPath(new URL('bayes/wikidata-facts.json', dataDir)), 'utf8'));
  } catch (_err) {
    // 未実行。
  }

  const postsByChar = new Map();
  for (const c of characters) {
    const entry = tagMap.entries[c.id];
    postsByChar.set(c.id, entry && entry.tag !== null ? loadDanbooruCache(cacheDir, c.id) : []);
  }

  // ---- グループ質問: グループ単位でn_G/k_qを先に全キャラ分集計してからb_qを出す ----
  const groupCoverageByChar = new Map(); // charId -> group -> {nG, kByTag}
  for (const c of characters) groupCoverageByChar.set(c.id, {});
  for (const [group, def] of Object.entries(questionsFile.groups)) {
    for (const c of characters) {
      const posts = postsByChar.get(c.id);
      groupCoverageByChar.get(c.id)[group] = countGroupCoverage(posts, def.coverageTags);
    }
  }
  const groupBaseRate = {}; // group -> tag -> b_q
  for (const [group, def] of Object.entries(questionsFile.groups)) {
    groupBaseRate[group] = {};
    for (const tag of def.coverageTags) {
      const perCharacter = characters.map((c) => {
        const cov = groupCoverageByChar.get(c.id)[group];
        return { k_q: cov.kByTag[tag], n_G: cov.nG };
      });
      groupBaseRate[group][tag] = computeGroupBaseRate(perCharacter);
    }
  }

  // ---- 二値質問: タグごとに全キャラの生率を集めてθ_qを出す ----
  const binaryTags = questionsFile.questions
    .flatMap((q) => q.sources)
    .filter((s) => s.type === 'danbooru-binary')
    .map((s) => s.tag);
  const uniqueBinaryTags = [...new Set(binaryTags)];
  const binaryRawRateByChar = new Map(); // tag -> charId -> rawRate
  const binaryKByChar = new Map(); // tag -> charId -> k_t
  for (const tag of uniqueBinaryTags) {
    const rawByChar = new Map();
    const kByChar = new Map();
    for (const c of characters) {
      const posts = postsByChar.get(c.id);
      const k = countBinary(posts, tag);
      kByChar.set(c.id, k);
      rawByChar.set(c.id, estimateBinaryRawRate({ k_t: k, n_c: posts.length }));
    }
    binaryRawRateByChar.set(tag, rawByChar);
    binaryKByChar.set(tag, kByChar);
  }
  const binaryTheta = {}; // tag -> theta_q
  const binaryFallback = {}; // tag -> clamp01(平均生率/theta)
  for (const tag of uniqueBinaryTags) {
    const rates = [...binaryRawRateByChar.get(tag).values()];
    const theta = computeBinaryTheta(rates);
    binaryTheta[tag] = theta;
    const meanRate = rates.reduce((a, b) => a + b, 0) / rates.length;
    binaryFallback[tag] = clamp01(meanRate / theta);
  }

  // ---- 質問ごとにキャラ×尤度を計算してマージ ----
  // questions.json の id（dg:hair-color:black_hair 等）はDanbooruタグ名を生のまま
  // 含む——data/bayes/questions.json はビルド時にしか読まれないので問題ないが、
  // likelihoods.json/questions.runtime.json は src からimportされ dist に
  // そのままバンドルされるため、id を実行時keyに転用するとタグ語彙が丸ごと
  // 成果物に混入する（2026-07-24、`grep dist/assets/*.js`で実際に db:thighhighs
  // 等が見えることを確認して発覚）。実行時keyは連番の不透明な識別子にし、
  // questions.json 側の id とはこのビルド内だけで対応させる。
  const questionIds = questionsFile.questions.map((_q, i) => `q${String(i + 1).padStart(3, '0')}`);
  const baseRates = [];
  const chars = Object.fromEntries(characters.map((c) => [c.id, []]));

  for (const q of questionsFile.questions) {
    const groupSource = q.sources.find((s) => s.type === 'danbooru-group');
    const binarySource = q.sources.find((s) => s.type === 'danbooru-binary');
    const axisSource = q.sources.find((s) => s.type === 'axis');
    const wikidataSource = q.sources.find((s) => s.type === 'wikidata');

    let fallback = 0.5;
    if (groupSource) fallback = groupBaseRate[groupSource.group][groupSource.tag];
    else if (binarySource) fallback = binaryFallback[binarySource.tag];
    // gigantic_breasts等、グローバル基底率そのものが[epsilon, 1-epsilon]の外に
    // 出ることがある（全キャラでも稀なタグ）。mergeLikelihoodsは内部でclamp01する
    // ためキャラ別尤度は安全だが、baseRates配列はそこを経由せず直接この値を
    // 書き出すのでここでも明示的にクランプする（2026-07-24、BA2テストで発覚）。
    fallback = clamp01(fallback);
    baseRates.push(round3(fallback));

    for (const c of characters) {
      const sources = [];
      if (groupSource) {
        const cov = groupCoverageByChar.get(c.id)[groupSource.group];
        const kQ = cov.kByTag[groupSource.tag];
        const nG = cov.nG;
        const bQ = groupBaseRate[groupSource.group][groupSource.tag];
        sources.push({ p: estimateGroupLikelihood({ k_q: kQ, n_G: nG, b_q: bQ }), weight: nG });
      }
      if (binarySource) {
        const posts = postsByChar.get(c.id);
        const kT = binaryKByChar.get(binarySource.tag).get(c.id);
        const theta = binaryTheta[binarySource.tag];
        sources.push({ p: estimateBinaryLikelihood({ k_t: kT, n_c: posts.length, theta }), weight: posts.length });
      }
      if (axisSource) {
        sources.push({ p: axisSourceLikelihood(c, axisSource), weight: AXIS_MERGE_WEIGHT });
      }
      if (wikidataSource) {
        const facts = wikidataFacts.entries[c.id];
        sources.push({ p: wikidataSourceLikelihood(facts, wikidataSource), weight: WIKIDATA_MERGE_WEIGHT });
      }
      const merged = mergeLikelihoods(sources, fallback);
      chars[c.id].push(round3(merged));
    }
  }

  const likelihoods = { epsilon: DEFAULT_EPSILON, questionIds, baseRates, chars };
  writeFileSync(
    fileURLToPath(new URL('bayes/likelihoods.json', dataDir)),
    `${JSON.stringify(likelihoods, null, 2)}\n`,
  );

  const runtime = {
    version: questionsFile.version,
    questions: questionsFile.questions.map((q, i) => ({ key: questionIds[i], prompt: q.prompt, reason: q.reason })),
  };
  writeFileSync(fileURLToPath(new URL('bayes/questions.runtime.json', dataDir)), `${JSON.stringify(runtime, null, 2)}\n`);

  console.log(`完了。${questionIds.length}問 × ${characters.length}キャラの尤度を書き込みました。`);
  console.log('  data/bayes/likelihoods.json');
  console.log('  data/bayes/questions.runtime.json');
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  await main();
}
