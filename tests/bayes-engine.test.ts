import { describe, expect, it } from 'vitest';

import type { Character, SupplyFile } from '../src/data/schema';
import likelihoodsData from '../data/bayes/likelihoods.json';
import questionsRuntimeData from '../data/bayes/questions.runtime.json';
import {
  HARD_CAP_BAYES,
  MIN_QUESTIONS_BAYES,
  bayesNextProbe,
  bayesScoreCharacters,
  bayesShouldGuess,
  type BayesAnswerMap,
  type BayesProbe,
  type Confidence,
  type Dataset,
  type Scored,
} from '../src/engine/bayes';
import { survivors, topGuess } from '../src/engine/recommend';
import { readJson } from './helpers/data';

/**
 * BC系(bayes-engine): tests/engine.test.ts のC系ミラー。プランで明示された
 * 9項目のみを対象にする（C9/C11/C12相当はベイズエンジンの設計上そのまま
 * 移植できない/対象外——質問選択がハード制約の作業集合を持たないため
 * CONTENTION_M相当の分岐が無く、スコア寄与も3値式ではなくベイズ更新式）。
 */
const dataset: Dataset = {
  characters: readJson<Character[]>('data/characters.json'),
  supply: readJson<SupplyFile>('data/supply.json'),
};

const likelihoods = likelihoodsData as { epsilon: number; questionIds: string[]; chars: Record<string, number[]> };
const QUESTION_INDEX = new Map(likelihoods.questionIds.map((id, i) => [id, i]));
function likelihoodOf(characterId: string, key: string): number {
  return likelihoods.chars[characterId][QUESTION_INDEX.get(key)!];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Strategy = (probe: BayesProbe) => Confidence;

function always(confidence: Confidence): Strategy {
  return () => confidence;
}

/** BC13のオラクル戦略: 対象キャラ自身の尤度から機械的に回答を生成する（PLAN定義通り）。 */
function oracleFor(target: Character): Strategy {
  return (probe) => {
    const p = likelihoodOf(target.id, probe.key);
    if (p >= 0.75) return 'yes';
    if (p <= 0.25) return 'no';
    return 'unknown';
  };
}

/**
 * bayesNextProbe/bayesScoreCharacters/bayesShouldGuess を実際のフロー
 * （P4のuseBayesInterview想定）と同じ短絡条件で最後まで駆動する。
 * cooldownはUI/セッション関心事なのでここではplainなtopGuessを使う
 * （tests/engine.test.ts のrunToGuessと同じ方針。cooldown自体は
 * tests/cooldown.test.ts がエンジン非依存に検証済み）。
 */
function runToGuess(
  dataset: Dataset,
  strategy: Strategy,
  opts?: { exclude?: ReadonlySet<string> },
): { guess: Scored; answers: BayesAnswerMap; askedKeys: Set<string> } {
  const answers: BayesAnswerMap = {};
  const askedKeys = new Set<string>();
  for (let guard = 0; guard <= HARD_CAP_BAYES + 2; guard += 1) {
    const probe = bayesNextProbe(dataset, answers, askedKeys, opts);
    const scored = bayesScoreCharacters(answers, dataset, opts);
    if (probe === null || bayesShouldGuess(scored, askedKeys.size, probe !== null)) {
      return { guess: topGuess(scored), answers, askedKeys };
    }
    answers[probe.key] = strategy(probe);
    askedKeys.add(probe.key);
  }
  throw new Error('runToGuess: ガードを超えた（無限ループの疑い）');
}

describe('BC. ベイズ推薦エンジン', () => {
  it('BC1: 固定の回答列に対し決定論的な単一推測を返す', () => {
    const run = () => runToGuess(dataset, always('yes'));
    const first = run();
    const second = run();

    expect(second.guess.character.id).toBe(first.guess.character.id);
    expect(second.guess.score).toBe(first.guess.score);
    expect({ id: first.guess.character.id, score: first.guess.score }).toMatchSnapshot();
  });

  it('BC2: 推測で返るキャラの供給量ランクが「なし」でない', () => {
    const rand = mulberry32(20260724);
    for (let i = 0; i < 50; i += 1) {
      const target = dataset.characters[Math.floor(rand() * dataset.characters.length)];
      const { guess } = runToGuess(dataset, oracleFor(target));
      expect(guess.supplyRank, guess.character.id).not.toBe('なし');
    }
  });

  it(
    'BC3: 無作為な1000通りの回答パスで bayesScoreCharacters が1件も空にならない',
    () => {
      const rand = mulberry32(1);
      const confidences: Confidence[] = ['yes', 'probably_yes', 'unknown', 'probably_no', 'no'];
      const empties: BayesAnswerMap[] = [];

      for (let i = 0; i < 1000; i += 1) {
        const answers: BayesAnswerMap = {};
        const askedKeys = new Set<string>();
        for (let q = 0; q < 8; q += 1) {
          const probe = bayesNextProbe(dataset, answers, askedKeys);
          if (!probe) break;
          answers[probe.key] = confidences[Math.floor(rand() * confidences.length)];
          askedKeys.add(probe.key);
        }
        if (bayesScoreCharacters(answers, dataset).length === 0) empties.push(answers);
      }
      expect(empties).toEqual([]);
    },
    // tests/engine.test.ts C3 と同じ理由（他ファイルとの並列実行時のCPU競合）で緩める。
    60000,
  );

  it('BC4: 全問「どちらでも良い」でも bayesScoreCharacters の結果が空にならず、HARD_CAP_BAYESで強制的に推測へ進む', () => {
    const { answers, askedKeys } = runToGuess(dataset, always('unknown'));
    expect(bayesScoreCharacters(answers, dataset).length).toBeGreaterThan(0);
    expect(askedKeys.size).toBe(HARD_CAP_BAYES);
  });

  it('BC5: 推測に付く根拠は実際に方向が強く一致する質問だけを挙げる（根拠の捏造を弾く）', () => {
    const rand = mulberry32(4242);
    for (let i = 0; i < 100; i += 1) {
      const target = dataset.characters[Math.floor(rand() * dataset.characters.length)];
      const { guess } = runToGuess(dataset, oracleFor(target));

      const traitReasons = guess.reasons.filter((r) => r.kind === 'trait');
      for (const reason of traitReasons) {
        const p = likelihoodOf(guess.character.id, reasonKeyFor(reason));
        const stronglyYes = reason.confidence === 'yes' || reason.confidence === 'probably_yes';
        if (stronglyYes) {
          expect(p, `${guess.character.id} ${reason.axis}=${reason.value}`).toBeGreaterThanOrEqual(0.8);
        } else {
          expect(p, `${guess.character.id} ${reason.axis}=${reason.value}`).toBeLessThanOrEqual(0.2);
        }
      }
      expect(guess.reasons.some((r) => r.kind === 'supply'), '供給量の根拠が無い').toBe(true);
    }
  });

  it('BC7: 性別表現「男性」または provisional のキャラが推測に出ない', () => {
    const EXCLUDED_IDS = ['aot-levi', 'onepiece-zoro', 'azurlane-yamato'];
    const rand = mulberry32(777);
    for (let i = 0; i < 100; i += 1) {
      const target = dataset.characters[Math.floor(rand() * dataset.characters.length)];
      const { guess } = runToGuess(dataset, oracleFor(target));
      expect(EXCLUDED_IDS, `${guess.character.id} が推測に出た`).not.toContain(guess.character.id);
    }
  });

  it('BC8: bayesNextProbe は askedKeys に無いプローブから選ばれ、同じプローブを2回聞かない', () => {
    const answers: BayesAnswerMap = {};
    const askedKeys = new Set<string>();
    const seen = new Set<string>();
    for (let guard = 0; guard <= HARD_CAP_BAYES; guard += 1) {
      const probe = bayesNextProbe(dataset, answers, askedKeys);
      if (!probe) break;
      expect(seen.has(probe.key), `${probe.key} を2回聞いた`).toBe(false);
      seen.add(probe.key);
      answers[probe.key] = 'yes';
      askedKeys.add(probe.key);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('BC10: 同じ (dataset, askedKeys) なら bayesNextProbe が同じ結果を返す（rng省略時は決定論）', () => {
    const a = bayesNextProbe(dataset, {}, new Set());
    const b = bayesNextProbe(dataset, {}, new Set());
    expect(b?.key).toBe(a?.key);

    const target = dataset.characters[0];
    const seq1 = [...runToGuess(dataset, oracleFor(target)).askedKeys];
    const seq2 = [...runToGuess(dataset, oracleFor(target)).askedKeys];
    expect(seq2).toEqual(seq1);
  });

  it('BC10: rng を指定すると同じシードで再現可能', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 20; seed += 1) {
      const rngA = mulberry32(seed);
      const rngB = mulberry32(seed);
      const a = bayesNextProbe(dataset, {}, new Set(), { rng: rngA });
      const b = bayesNextProbe(dataset, {}, new Set(), { rng: rngB });
      expect(b?.key).toBe(a?.key);
      if (a) seen.add(a.key);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it(
    'BC13: reachable(=survivors)な全キャラの95%以上が、尤度オラクル回答で自分自身に収束する（MIN_QUESTIONS_BAYES〜HARD_CAP_BAYES問の範囲内）',
    () => {
      // survivors()を直接使う（以前はここで一部だけ再実装しており、reviewed等の
      // ハードフィルタ追加に追随できていなかった。2026-08-01発覚）。
      const reachable = survivors(dataset);
      const askedCounts: number[] = [];
      const failures: string[] = [];

      for (const target of reachable) {
        const { guess, askedKeys } = runToGuess(dataset, oracleFor(target));
        askedCounts.push(askedKeys.size);
        if (guess.character.id !== target.id) {
          failures.push(`${target.id}: guessed=${guess.character.id} after ${askedKeys.size}問`);
        }
      }

      const convergedRatio = (reachable.length - failures.length) / reachable.length;
      // 質問キュレーションへのフィードバック用に失敗リストを常に表示する（成功時も含めて可視化）。
      expect(convergedRatio, `未収束: ${JSON.stringify(failures)}`).toBeGreaterThanOrEqual(0.95);
      expect(Math.min(...askedCounts)).toBeGreaterThanOrEqual(MIN_QUESTIONS_BAYES);
      expect(Math.max(...askedCounts)).toBeLessThanOrEqual(HARD_CAP_BAYES);
    },
    60000,
  );
});

/** reason.value から元の質問key（"ax:axis=value" 等）を復元するのではなく、
 * axis/valueの組から questions.runtime.json 内の一致するキーを逆引きする。 */
function reasonKeyFor(reason: { axis: string; value: string }): string {
  const matches = (questionsRuntimeData as { questions: { key: string; reason: { axis: string; value: string } }[] }).questions.filter(
    (q) => q.reason.axis === reason.axis && q.reason.value === reason.value,
  );
  if (matches.length === 0) throw new Error(`reasonKeyFor: 対応する質問が見つからない (axis=${reason.axis}, value=${reason.value})`);
  // (axis, value) が複数の質問で重複すると根拠→尤度の逆引きが不定になる
  // （BA1のようなdata側テストではなく、ここでは"検証ロジック自体の前提"として明示的に落とす）。
  if (matches.length > 1) throw new Error(`reasonKeyFor: (axis=${reason.axis}, value=${reason.value}) が複数の質問と衝突`);
  return matches[0].key;
}
