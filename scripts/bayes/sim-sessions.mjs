#!/usr/bin/env node
/**
 * 遊び方ごとの質問の出し方・止め方を、外して聞き直すところまで含めて1回のプレイを最後まで再現して測る(R14)。
 * 本物のエンジン(src/engine/bayes.ts)と QUESTION_POLICIES、止め方は bayesShouldGuess / bayesShouldReguess をそのまま使う。
 * 通信なし・乱数は固定(同じ引数なら同じ結果)。
 *
 *   node --no-warnings scripts/bayes/sim-sessions.mjs <guess|discover> <persona> [random=60] [minor=40] [hoshino=20] [seed=20261031]
 *
 * persona(答え方。確率は likelihoods.json から決める。率は測る側が置いた前提で、実際のプレイとは違いうる):
 *   human   自信のない答えにまちがいが混ざる(目の色・小物は覚えていないことが多い)
 *   human2  human に加えて、最初の12問のうち2問に確実なまちがいを混ぜる
 *   harsh   データと見方がずれる人(どちらとも言えない質問も自分の感覚で答え、まちがえるときも言い切る)
 * 対象: random=無作為のキャラ / minor=供給量が下位4分の1のマイナーなキャラ / hoshino=ホシノ(bluearchive-hoshino)の繰り返し。
 *
 * 結果は state/question-modes/out/sim-<遊び方>-<persona>-<random>-<minor>-<hoshino>-<seed>.json に書く(state/ は git の対象外)。
 */
import './ts-hook.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, ROOT), 'utf8'));
const engine = await import('../../src/engine/bayes.ts');
const { survivors, topGuess } = await import('../../src/engine/recommend.ts');

const MODES = ['guess', 'discover'];
const MAX_TOTAL = 80;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 答え方 ----
// 「覚えていないことが多い質問」は、当てるで聞かない質問(modes.guess.skip)と同じ21問:
// 目の色(questions.json の id が dg:eye-color:)と、それ以外の細かい見た目・小物。
const NOISY = new Set(['personality', 'distance', 'mood', 'roles']);
const BODY = new Set(['bust', 'build', 'stature']);

function makePersonas(likelihoods, runtime, questionIds) {
  const index = new Map(likelihoods.questionIds.map((id, i) => [id, i]));
  const P = (id, key) => likelihoods.chars[id][index.get(key)];
  const axisOf = new Map(runtime.questions.map((q) => [q.key, q.reason.axis]));
  const eye = new Set();
  const small = new Set();
  runtime.questions.forEach((q, i) => {
    if (q.modes?.guess?.skip !== true) return;
    (questionIds[i].startsWith('dg:eye-color:') ? eye : small).add(q.key);
  });

  const truth = (id, key) => {
    const p = P(id, key);
    return p >= 0.75 ? 'yes' : p <= 0.25 ? 'no' : 'unknown';
  };
  const soft = (a) => (a === 'yes' ? 'probably_yes' : a === 'no' ? 'probably_no' : a);
  const wrong = (a) => (a === 'yes' ? 'probably_no' : a === 'no' ? 'probably_yes' : a);

  function humanAnswer(id, key, rand) {
    const a = truth(id, key);
    if (a === 'unknown') return a;
    const axis = axisOf.get(key);
    if (eye.has(key)) {
      if (rand() < 0.4) return 'unknown';
      return rand() < 0.25 ? wrong(a) : soft(a);
    }
    if (small.has(key)) {
      if (rand() < 0.5) return 'unknown';
      return rand() < 0.2 ? wrong(a) : soft(a);
    }
    if (axis === 'hairColor') return rand() < 0.01 ? wrong(a) : a;
    if (BODY.has(axis)) return rand() < 0.05 ? wrong(a) : a;
    if (NOISY.has(axis)) return rand() < 0.1 ? wrong(a) : soft(a);
    return rand() < 0.03 ? wrong(a) : a;
  }

  function harshAnswer(id, key, rand) {
    const p = P(id, key);
    const axis = axisOf.get(key);
    let a;
    if (p >= 0.75) a = 'yes';
    else if (p <= 0.25) a = 'no';
    else {
      if (rand() < 0.3) return 'unknown';
      a = rand() < p ? 'yes' : 'no';
    }
    const flip = a === 'yes' ? 'no' : 'yes';
    if (eye.has(key)) {
      if (rand() < 0.4) return 'unknown';
      return rand() < 0.3 ? flip : a;
    }
    if (small.has(key)) {
      if (rand() < 0.5) return 'unknown';
      return rand() < 0.3 ? flip : a;
    }
    if (axis === 'hairColor') return rand() < 0.03 ? flip : a;
    if (BODY.has(axis)) return rand() < 0.1 ? flip : a;
    if (NOISY.has(axis)) return rand() < 0.25 ? flip : a;
    return rand() < 0.08 ? flip : a;
  }

  return {
    harsh: (id, rand) => (key) => harshAnswer(id, key, rand),
    human: (id, rand) => (key) => humanAnswer(id, key, rand),
    human2: (id, rand) => {
      const a = Math.floor(rand() * 12);
      let b = Math.floor(rand() * 11);
      if (b >= a) b += 1;
      let n = 0;
      return (key) => {
        const i = n;
        n += 1;
        if (i === a || i === b) return wrong(truth(id, key));
        return humanAnswer(id, key, rand);
      };
    },
  };
}

/** 本番の isConfidentEnough(非公開)と同じ式。推測が「差がついて」出たか、上限で「無理やり」出たかを分けて数えるためだけに使う。 */
function isConfident(scored) {
  if (scored.length < 2) return true;
  const p1 = scored[0].score / engine.SCORE_SCALE;
  const p2 = scored[1].score / engine.SCORE_SCALE;
  return p1 >= engine.P_STOP && p1 / p2 >= engine.ODDS_STOP;
}

/** 1回のプレイ: 質問 -> (止め方で)推測 -> 外れたら除いて聞き直し -> 推測 ... を、当たるか MAX_TOTAL 問になるまで。 */
function play(dataset, policy, target, answer, rand) {
  const answers = {};
  const askedSet = new Set();
  const rejected = new Set();
  const guesses = [];
  let since = null;
  for (;;) {
    const probe = engine.bayesNextProbe(dataset, answers, askedSet, { exclude: rejected, rng: rand, policy });
    const scored = engine.bayesScoreCharacters(answers, dataset, { exclude: rejected });
    if (scored.length === 0) return { found: false, total: askedSet.size, guesses };
    const go =
      probe === null ||
      (since === null
        ? engine.bayesShouldGuess(scored, askedSet.size, true, policy)
        : engine.bayesShouldReguess(scored, since, true, policy));
    if (go) {
      const conf = isConfident(scored);
      const g = topGuess(scored, rand);
      const p1 = scored[0].score / engine.SCORE_SCALE;
      const p2 = (scored[1]?.score ?? 0) / engine.SCORE_SCALE;
      const ok = g.character.id === target;
      const rank = scored.findIndex((s) => s.character.id === target);
      guesses.push({ at: askedSet.size, conf, p1, odds: p2 > 0 ? p1 / p2 : null, ok, rank, id: g.character.id });
      if (ok) return { found: true, total: askedSet.size, guesses };
      rejected.add(g.character.id);
      since = 0;
      if (askedSet.size >= MAX_TOTAL) return { found: false, total: askedSet.size, guesses };
      continue;
    }
    if (askedSet.size >= MAX_TOTAL) return { found: false, total: askedSet.size, guesses };
    answers[probe.key] = answer(probe.key);
    askedSet.add(probe.key);
    if (since !== null) since += 1;
  }
}

function summarize(rows) {
  const totals = rows.map((r) => r.total).sort((a, b) => a - b);
  const all = rows.flatMap((r) => r.guesses);
  const forced = all.filter((g) => !g.conf);
  const sure = all.filter((g) => g.conf);
  const rate = (xs) => (xs.length === 0 ? null : +(xs.filter((g) => g.ok).length / xs.length).toFixed(3));
  const mean = (xs) => +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1);
  return {
    n: rows.length,
    firstHit: +(rows.filter((r) => r.guesses[0]?.ok).length / rows.length).toFixed(3),
    firstAt: mean(rows.map((r) => r.guesses[0]?.at ?? r.total)),
    found: +(rows.filter((r) => r.found).length / rows.length).toFixed(3),
    meanQ: mean(totals),
    medianQ: totals[Math.floor(totals.length / 2)],
    p90Q: totals[Math.floor(totals.length * 0.9)],
    over30: +(rows.filter((r) => r.total >= 30).length / rows.length).toFixed(3),
    over50: +(rows.filter((r) => r.total >= 50).length / rows.length).toFixed(3),
    meanWrong: mean(rows.map((r) => r.guesses.filter((g) => !g.ok).length)),
    forcedShare: all.length === 0 ? null : +(forced.length / all.length).toFixed(3),
    forcedHit: rate(forced),
    sureHit: rate(sure),
  };
}

const [modeName, personaName, rArg = '60', mArg = '40', hArg = '20', seedArg = '20261031'] = process.argv.slice(2);

const likelihoods = read('data/bayes/likelihoods.json');
const runtime = read('data/bayes/questions.runtime.json');
const questionIds = read('data/bayes/questions.json').questions.map((q) => q.id);
const PERSONAS = makePersonas(likelihoods, runtime, questionIds);
if (!MODES.includes(modeName) || !(personaName in PERSONAS)) {
  console.error('使い方: node --no-warnings scripts/bayes/sim-sessions.mjs <guess|discover> <human|human2|harsh> [random=60] [minor=40] [hoshino=20] [seed=20261031]');
  process.exit(1);
}
engine.initBayesData(likelihoods, runtime);

const dataset = { characters: read('data/characters.json'), supply: read('data/supply.json') };
const policy = engine.QUESTION_POLICIES[modeName];
const seed = Number(seedArg);
const pool = survivors(dataset);
const V = (c) => {
  const s = dataset.supply[c.id];
  return (s?.hitomi?.galleryCount ?? 0) + 30 * (s?.pageCount ?? 0);
};
const sorted = [...pool].sort((a, b) => V(a) - V(b));
const minorPool = sorted.slice(0, Math.floor(sorted.length / 4));
const pick = mulberry32(seed);
const sample = (from, n) => Array.from({ length: n }, () => from[Math.floor(pick() * from.length)]);
const hoshino = pool.find((c) => c.id === 'bluearchive-hoshino');
if (hoshino === undefined && Number(hArg) > 0) {
  console.error('bluearchive-hoshino が候補にいません(hoshino を 0 にしてください)');
  process.exit(1);
}
const groups = {
  random: sample(pool, Number(rArg)),
  minor: sample(minorPool, Number(mArg)),
  hoshino: Array.from({ length: Number(hArg) }, () => hoshino),
};

const out = { mode: modeName, persona: personaName, seed, policy, groups: {} };
const t0 = Date.now();
for (const [gname, targets] of Object.entries(groups)) {
  const rows = [];
  for (const [i, t] of targets.entries()) {
    const rand = mulberry32(seed * 7 + i + gname.length * 1000);
    const ansRand = mulberry32(seed * 13 + i + gname.length * 1000);
    const r = play(dataset, policy, t.id, PERSONAS[personaName](t.id, ansRand), rand);
    rows.push({ id: t.id, name: t.name, ...r });
  }
  if (rows.length === 0) continue;
  out.groups[gname] = { summary: summarize(rows), rows };
  console.log(modeName, personaName, gname, JSON.stringify(out.groups[gname].summary));
}
console.log('seconds', Math.round((Date.now() - t0) / 1000));
const outDir = new URL('state/question-modes/out/', ROOT);
mkdirSync(fileURLToPath(outDir), { recursive: true });
writeFileSync(
  fileURLToPath(new URL(`sim-${modeName}-${personaName}-${rArg}-${mArg}-${hArg}-${seed}.json`, outDir)),
  JSON.stringify(out),
);
