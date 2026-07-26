import { describe, it } from 'vitest';

import type { Character, SupplyFile } from '../src/data/schema';
import { HARD_CAP, MIN_QUESTIONS } from '../src/engine/questions';
import { nextProbe, scoreCharacters, shouldGuess, survivors, topGuess, type AnswerMap, type Confidence, type Dataset, type Probe } from '../src/engine/recommend';
import {
  HARD_CAP_BAYES,
  MIN_QUESTIONS_BAYES,
  bayesNextProbe,
  bayesScoreCharacters,
  bayesShouldGuess,
  type BayesAnswerMap,
  type BayesProbe,
} from '../src/engine/bayes';
import { readJson } from './helpers/data';

/**
 * classic(C13)とbayes(BC13)の「本採用検討」用ヘッドツーヘッド比較ハーネス
 * （PLAN対象外、トラック3の判断材料づくり）。
 *
 * BC13の自己収束テストは`data/bayes/likelihoods.json`自身から回答オラクルを
 * 生成する自己参照設計（「行列との整合性」しか測れない）。ここでは両エンジンに
 * **同一の独立オラクル**（`characters.json`の査読済み/下書きaxesそのもの、
 * classicのC13オラクルと同じ発想）を与え、収束率・平均質問数を横並びで出す。
 *
 * 通常のnpm testには含めない（`RUN_HEAD_TO_HEAD=1`を付けたときだけ実行）。
 * gitignore対象のstate/bayes-review/に結果報告書を出す想定だったが、
 * vitest.config.tsのincludeが`tests/**`固定でstate/配下のテストファイルを
 * 実行できないため、このファイル自体はtests/に置き、出力先だけstate/へ逃がす。
 *
 * 使い方: RUN_HEAD_TO_HEAD=1 npx vitest run tests/bayes-headtohead.test.ts
 */
const RUN = process.env.RUN_HEAD_TO_HEAD === '1';

const dataset: Dataset = {
  characters: readJson<Character[]>('data/characters.json'),
  supply: readJson<SupplyFile>('data/supply.json'),
};

/** classicと同じ発想: targetの実際の属性に沿って正直に答える独立オラクル。 */
function classicOracle(target: Character) {
  return (probe: Probe): Confidence => {
    const raw = target.axes[probe.axis];
    const has = probe.multi ? Array.isArray(raw) && raw.includes(probe.value) : raw === probe.value;
    return has ? 'yes' : 'no';
  };
}

/**
 * bayes版の独立オラクル。BC13の自己参照オラクル(likelihoods.jsonから生成)とは違い、
 * classicOracleと全く同じ`characters.json`のaxesを直接見る——比較を公平にする核心部分。
 */
function bayesIndependentOracle(target: Character) {
  return (probe: BayesProbe): Confidence => {
    const raw = target.axes[probe.reason.axis as keyof Character['axes']];
    const has = Array.isArray(raw) ? raw.includes(probe.reason.value) : raw === probe.reason.value;
    return has ? 'yes' : 'no';
  };
}

function runClassicToGuess(target: Character) {
  const strategy = classicOracle(target);
  const answers: AnswerMap = {};
  const askedKeys = new Set<string>();
  for (let guard = 0; guard <= HARD_CAP + 2; guard += 1) {
    const probe = nextProbe(dataset, answers, askedKeys);
    const scored = scoreCharacters(answers, dataset);
    if (probe === null || shouldGuess(scored, askedKeys.size, probe !== null)) {
      return { guess: topGuess(scored), askedCount: askedKeys.size };
    }
    answers[probe.key] = strategy(probe);
    askedKeys.add(probe.key);
  }
  throw new Error('runClassicToGuess: ガードを超えた');
}

function runBayesToGuess(target: Character) {
  const strategy = bayesIndependentOracle(target);
  const answers: BayesAnswerMap = {};
  const askedKeys = new Set<string>();
  for (let guard = 0; guard <= HARD_CAP_BAYES + 2; guard += 1) {
    const probe = bayesNextProbe(dataset, answers, askedKeys);
    const scored = bayesScoreCharacters(answers, dataset);
    if (probe === null || bayesShouldGuess(scored, askedKeys.size, probe !== null)) {
      return { guess: topGuess(scored), askedCount: askedKeys.size };
    }
    answers[probe.key] = strategy(probe);
    askedKeys.add(probe.key);
  }
  throw new Error('runBayesToGuess: ガードを超えた');
}

describe.skipIf(!RUN)('ヘッドツーヘッド比較（RUN_HEAD_TO_HEAD=1でのみ実行、通常ゲート対象外）', () => {
  it('classic C13相当のオラクルをbayesにも同一に与え、収束率・平均質問数を比較する', () => {
    const targets = survivors(dataset);
    const rows: { id: string; classicOk: boolean; classicN: number; bayesOk: boolean; bayesN: number }[] = [];

    for (const target of targets) {
      const c = runClassicToGuess(target);
      const b = runBayesToGuess(target);
      rows.push({
        id: target.id,
        classicOk: c.guess.character.id === target.id,
        classicN: c.askedCount,
        bayesOk: b.guess.character.id === target.id,
        bayesN: b.askedCount,
      });
    }

    const classicConverged = rows.filter((r) => r.classicOk).length;
    const bayesConverged = rows.filter((r) => r.bayesOk).length;
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

    console.log(`対象 ${targets.length} 体（同一の独立オラクル = characters.json実データ）`);
    console.log(
      `classic: 収束 ${classicConverged}/${targets.length} (${((classicConverged / targets.length) * 100).toFixed(1)}%)` +
        `, 平均質問数 ${avg(rows.map((r) => r.classicN)).toFixed(2)} (範囲 ${MIN_QUESTIONS}-${HARD_CAP})`,
    );
    console.log(
      `bayes:   収束 ${bayesConverged}/${targets.length} (${((bayesConverged / targets.length) * 100).toFixed(1)}%)` +
        `, 平均質問数 ${avg(rows.map((r) => r.bayesN)).toFixed(2)} (範囲 ${MIN_QUESTIONS_BAYES}-${HARD_CAP_BAYES})`,
    );

    const classicOnlyFail = rows.filter((r) => !r.classicOk && r.bayesOk);
    const bayesOnlyFail = rows.filter((r) => r.classicOk && !r.bayesOk);
    const bothFail = rows.filter((r) => !r.classicOk && !r.bayesOk);
    console.log(`classicのみ未収束: ${classicOnlyFail.length}件 [${classicOnlyFail.map((r) => r.id).join(', ')}]`);
    console.log(`bayesのみ未収束: ${bayesOnlyFail.length}件 [${bayesOnlyFail.map((r) => r.id).join(', ')}]`);
    console.log(`両方未収束: ${bothFail.length}件 [${bothFail.map((r) => r.id).join(', ')}]`);
  });
});
