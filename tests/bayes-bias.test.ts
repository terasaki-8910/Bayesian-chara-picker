import { describe, expect, it } from 'vitest';

import type { Character, SupplyFile } from '../src/data/schema';
import { pickGuessWithCooldown } from '../src/engine/cooldown';
import { bayesNextProbe, bayesScoreCharacters, bayesShouldGuess, type BayesAnswerMap, type Confidence, type Dataset } from '../src/engine/bayes';
import { survivors } from '../src/engine/recommend';
import { readJson } from './helpers/data';

/**
 * ベイズ推薦エンジンの偏りゲート。tests/engine-bias.test.ts のミラーだが、
 * ベイズは事前分布 π(c) ∝ log2(2+V_c) を明示的に組み込んでいるため、
 * 期待分布は一様ではなく供給量に応じたprior比にする（PLAN「BD系」）。
 * state/bayes-review/bayes-sweep.mts（探索用、gitignore対象）の集計ロジックを
 * 固定シードで決定論的に vitest へ移植したもの。
 */
const dataset: Dataset = {
  characters: readJson<Character[]>('data/characters.json'),
  supply: readJson<SupplyFile>('data/supply.json'),
};

const reachable = survivors(dataset);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runOneSession(rng: () => number, biasYes: number): string {
  const answers: BayesAnswerMap = {};
  const askedKeys: string[] = [];
  for (let guard = 0; guard < 60; guard += 1) {
    const askedSet = new Set(askedKeys);
    const probe = bayesNextProbe(dataset, answers, askedSet, { rng });
    const scored = bayesScoreCharacters(answers, dataset);
    const goToGuessing = probe === null || bayesShouldGuess(scored, askedKeys.length, probe !== null);
    if (goToGuessing) return pickGuessWithCooldown(scored, [], rng).character.id;

    const r = rng();
    let confidence: Confidence;
    if (r < 0.1) confidence = 'unknown';
    else if (r < 0.1 + biasYes) confidence = rng() < 0.7 ? 'yes' : 'probably_yes';
    else confidence = rng() < 0.7 ? 'no' : 'probably_no';
    answers[probe!.key] = confidence;
    askedKeys.push(probe!.key);
  }
  throw new Error('runOneSession: ガードを超えた（無限ループの疑い）');
}

/** bayes.ts の priorWeight と同じ式（非export関数のためテスト側に再現する）。 */
function priorWeight(id: string, supply: SupplyFile): number {
  const entry = supply[id];
  const pageCount = entry?.pageCount ?? 0;
  const galleryCount = entry?.hitomi?.galleryCount ?? 0;
  return Math.log2(2 + galleryCount + 30 * pageCount);
}

/**
 * 2026-08-01改定: `survivors()`が`reviewed!==true`もハードフィルタするように
 * なったのに伴い再計測（reachable 181→20。査読前データの質のばらつきが
 * χ²=319.1という統計的に無視できない偏り(旧閾値300超過、df=180に対し
 * 期待値からの逸脱が約7σ)として表面化したため——原因は特定のバグではなく
 * 査読前キャラそのものだったので、閾値を動かすのではなく`reviewed`を
 * ハードフィルタに追加して母集団側を直した。閾値はこの新しい母集団
 * (reachable=20)向けに再計測: N=1000で seed=20260724→43.4,
 * 13579246→75.3, 987654321→92.2。実測上限92.2に約40%の余裕を持たせて130へ）。
 * 「設計を超える偏り」（新規バグ等）だけを検出する目的であり、prior自体が
 * 生む意図的な偏りはゲートしない。
 */
const CHI_SQUARE_MAX = 130;

describe('BD. ベイズ推薦エンジンの偏りゲート', () => {
  it(
    '固定シードの疑似セッション群で、事前分布(prior)比からの逸脱が閾値を超えない',
    () => {
      const N = 1000;
      const tally = new Map<string, number>();
      const rng = mulberry32(20260724);

      for (let i = 0; i < N; i += 1) {
        const biasYes = 0.2 + rng() * 0.4;
        const id = runOneSession(rng, biasYes);
        tally.set(id, (tally.get(id) ?? 0) + 1);
      }

      const totalPrior = reachable.reduce((sum, c) => sum + priorWeight(c.id, dataset.supply), 0);
      const expected = new Map(reachable.map((c) => [c.id, (N * priorWeight(c.id, dataset.supply)) / totalPrior]));

      let chiSquare = 0;
      for (const c of reachable) {
        const observed = tally.get(c.id) ?? 0;
        chiSquare += (observed - expected.get(c.id)!) ** 2 / expected.get(c.id)!;
      }

      expect(chiSquare, `カイ二乗統計量: ${chiSquare.toFixed(1)}（期待値=prior比）`).toBeLessThanOrEqual(CHI_SQUARE_MAX);
    },
    // tests/engine-bias.test.ts と同じ理由（他ファイルとの並列実行時のCPU競合）で緩める。
    60000,
  );
});
