import { describe, expect, it } from 'vitest';

import type { Character, SupplyFile } from '../src/data/schema';
import { QUESTIONS } from '../src/engine/questions';
import { SUPPLY_RANKS, supplyRank, supplyRankIndex } from '../src/engine/supply';
import { omakase, recommend, type Answers, type Dataset } from '../src/engine/recommend';
import { readJson } from './helpers/data';

const dataset: Dataset = {
  characters: readJson<Character[]>('data/characters.json'),
  supply: readJson<SupplyFile>('data/supply.json'),
};

/** シード固定の疑似乱数（mulberry32）。テスト側で完結させ、実装の乱数に依存しない。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 全問に回答した 1 パスを作る。null = こだわらない。 */
function randomAnswers(rand: () => number): Answers {
  const answers: Answers = {};
  for (const q of QUESTIONS) {
    // 選択肢 + 「こだわらない」から 1 つ選ぶ。
    const index = Math.floor(rand() * (q.options.length + 1));
    answers[q.id] = index === q.options.length ? null : q.options[index].value;
  }
  return answers;
}

/** 各質問の第 1 選択肢で回答した固定パス（C1 用）。 */
const FIXED_ANSWERS: Answers = Object.fromEntries(
  QUESTIONS.map((q) => [q.id, q.options[0].value]),
);

const ALL_NO_PREFERENCE: Answers = Object.fromEntries(QUESTIONS.map((q) => [q.id, null]));

describe('質問セットの前提（SPEC 2.4）', () => {
  it('質問数は 6〜8 問', () => {
    expect(QUESTIONS.length).toBeGreaterThanOrEqual(6);
    expect(QUESTIONS.length).toBeLessThanOrEqual(8);
  });

  it('各質問は 2 つ以上の選択肢を持ち、id が一意', () => {
    const ids = new Set<string>();
    for (const q of QUESTIONS) {
      expect(q.options.length, `${q.id} の選択肢数`).toBeGreaterThanOrEqual(2);
      expect(ids.has(q.id), `${q.id} が重複`).toBe(false);
      ids.add(q.id);
    }
  });
});

describe('C. 推薦エンジン', () => {
  it('C1: 固定の回答セットに対し決定論的な上位 N を返す', () => {
    const first = recommend(FIXED_ANSWERS, dataset);
    const second = recommend(FIXED_ANSWERS, dataset);

    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(first.length).toBeLessThanOrEqual(5);

    // スコア降順で並んでいること。
    const scores = first.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));

    // 変化検知用。id とスコアだけを固定する（表示文言の変更で落ちないように）。
    expect(first.map((r) => ({ id: r.character.id, score: r.score }))).toMatchSnapshot();
  });

  it('C2: 返るキャラの供給量ランクが全て「僅少」以上', () => {
    const rand = mulberry32(20260720);
    for (let i = 0; i < 200; i += 1) {
      const results = recommend(randomAnswers(rand), dataset);
      for (const r of results) {
        expect(
          supplyRankIndex(r.supplyRank),
          `${r.character.id} の供給量ランクが ${r.supplyRank}`,
        ).toBeGreaterThanOrEqual(supplyRankIndex('僅少'));
      }
    }
  });

  it('C3: 無作為な 1000 通りの完走回答パスで結果が 1 件も空にならない', () => {
    const rand = mulberry32(1);
    const empties: Answers[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const answers = randomAnswers(rand);
      if (recommend(answers, dataset).length === 0) empties.push(answers);
    }
    expect(empties).toEqual([]);
  });

  it('C4: 全問「こだわらない」でも結果が空にならない', () => {
    const results = recommend(ALL_NO_PREFERENCE, dataset);
    expect(results.length).toBeGreaterThan(0);
  });

  it('C5: 各結果に根拠が 1 つ以上付く', () => {
    const rand = mulberry32(31337);
    for (let i = 0; i < 200; i += 1) {
      const results = recommend(randomAnswers(rand), dataset);
      for (const r of results) {
        expect(r.reasons.length, `${r.character.id} に根拠が無い`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('C5: 軸の根拠は実際に一致した軸だけを挙げる（根拠の捏造を弾く）', () => {
    const rand = mulberry32(4242);
    const axisByQuestion = new Map(QUESTIONS.map((q) => [q.axis, q]));

    for (let i = 0; i < 200; i += 1) {
      const answers = randomAnswers(rand);
      for (const r of recommend(answers, dataset)) {
        for (const reason of r.reasons) {
          if (reason.kind !== 'axis') continue;
          const question = axisByQuestion.get(reason.axis);
          expect(question, `軸 ${reason.axis} に対応する質問が無い`).toBeDefined();

          const answered = answers[question!.id];
          expect(answered, `未回答の軸 ${reason.axis} を根拠にしている`).not.toBeNull();

          const value = r.character.axes[reason.axis];
          const matched = Array.isArray(value) ? value.includes(answered!) : value === answered;
          expect(matched, `${r.character.id} は ${reason.axis}=${answered} に一致しない`).toBe(true);
        }
      }
    }
  });

  it('C6: おまかせがシード固定時に再現可能な結果を返す', () => {
    const a = omakase(dataset, { seed: 12345 });
    const b = omakase(dataset, { seed: 12345 });
    expect(b.map((r) => r.character.id)).toEqual(a.map((r) => r.character.id));
    expect(a.length).toBeGreaterThan(0);
  });

  it('C6: おまかせは供給量「少ない」以上のみを返す（SPEC 2.4）', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      for (const r of omakase(dataset, { seed })) {
        expect(
          supplyRankIndex(r.supplyRank),
          `${r.character.id} の供給量ランクが ${r.supplyRank}`,
        ).toBeGreaterThanOrEqual(supplyRankIndex('少ない'));
      }
    }
  });

  it('C6: シードが違えば選ばれる顔ぶれも変わりうる（乱択が効いている）', () => {
    const signatures = new Set(
      Array.from({ length: 30 }, (_, seed) =>
        omakase(dataset, { seed })
          .map((r) => r.character.id)
          .join(','),
      ),
    );
    // 全シードで同一結果 = 乱択が効いていない。
    expect(signatures.size).toBeGreaterThan(1);
  });
});

describe('供給量ランクの段階化（SPEC 2.3）', () => {
  it('pageCount をランクに写像する', () => {
    expect(supplyRank(0)).toBe('なし');
    expect(supplyRank(1)).toBe('僅少');
    expect(supplyRank(2)).toBe('少ない');
    expect(supplyRank(5)).toBe('少ない');
    expect(supplyRank(6)).toBe('十分');
    expect(supplyRank(20)).toBe('十分');
    expect(supplyRank(21)).toBe('豊富');
    expect(supplyRank(999)).toBe('豊富');
  });

  it('ランクの順序が定義どおり', () => {
    expect([...SUPPLY_RANKS]).toEqual(['なし', '僅少', '少ない', '十分', '豊富']);
    expect(supplyRankIndex('なし')).toBe(0);
    expect(supplyRankIndex('豊富')).toBe(4);
  });
});
