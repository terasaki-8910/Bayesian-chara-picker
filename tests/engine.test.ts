import { describe, expect, it } from 'vitest';

import type { AxisKey, Character, SupplyFile } from '../src/data/schema';
import { MAX_QUESTIONS, QUESTION_POOL, type Question } from '../src/engine/questions';
import { omakase, recommend, nextQuestion, type Answers, type Dataset } from '../src/engine/recommend';
import { SUPPLY_RANKS, supplyRank, supplyRankIndex } from '../src/engine/supply';
import { AXIS_VALUES, MULTI_AXES, REQUIRED_AXES, readJson } from './helpers/data';

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

/**
 * 質問は固定配列ではなく `nextQuestion` が動的に選ぶ（SPEC 2.4）ので、
 * 「全問に回答する」はセッションを最後まで駆動する操作になる。
 * `choose` が各質問への回答を決める。
 */
function runInterview(dataset: Dataset, choose: (q: Question) => string | null): Answers {
  const answers: Answers = {};
  const asked: AxisKey[] = [];
  for (let guard = 0; guard <= MAX_QUESTIONS; guard += 1) {
    const q = nextQuestion(dataset, answers, asked);
    if (!q) break;
    answers[q.axis] = choose(q);
    asked.push(q.axis);
  }
  return answers;
}

/** 各質問を「選択肢 + こだわらない」から無作為に選んで完走した 1 パス。 */
function randomInterview(dataset: Dataset, rand: () => number): Answers {
  return runInterview(dataset, (q) => {
    const index = Math.floor(rand() * (q.options.length + 1));
    return index === q.options.length ? null : q.options[index].value;
  });
}

/**
 * C9/C10 用の合成キャラを作る。既定値は全軸固定（エントロピー 0）にしておき、
 * テストごとに狙った軸だけ分布を作る。
 */
function makeSyntheticCharacter(id: string, axesOverrides: Partial<Character['axes']> = {}): Character {
  return {
    id,
    name: id,
    aliases: [],
    series: 'synthetic',
    dlsiteQuery: null,
    hitomiQuery: null,
    reviewed: false,
    provisional: false,
    axes: {
      genderExpression: '女性',
      ageFeel: '同年代',
      build: '標準',
      bust: '標準',
      personality: 'クール',
      roles: [],
      distance: null,
      looks: [],
      hairColor: '黒',
      skinTone: null,
      outfit: [],
      species: null,
      mood: null,
      combat: '戦う',
      affiliationKind: '学生',
      affiliationName: null,
      ...axesOverrides,
    },
  };
}

function syntheticSupplyEntry() {
  return {
    pageCount: 5,
    estimatedRange: [121, 150] as [number, number],
    byWorkType: {},
    fetchedAt: '2026-07-20T00:00:00Z',
    hitomi: null,
  };
}

describe('質問プール（候補軸。SPEC 2.4）', () => {
  it('複数値軸（roles/looks/outfit）を含まない', () => {
    for (const q of QUESTION_POOL) {
      expect((MULTI_AXES as readonly string[]).includes(q.axis), `${q.axis} が複数値軸`).toBe(false);
    }
  });

  it('affiliationName を固定プールに含まない（動的深掘り専用）', () => {
    expect(QUESTION_POOL.some((q) => q.axis === 'affiliationName')).toBe(false);
  });

  it('id と axis が一致し、id が一意', () => {
    const ids = new Set<string>();
    for (const q of QUESTION_POOL) {
      expect(q.id).toBe(q.axis);
      expect(ids.has(q.id), `${q.id} が重複`).toBe(false);
      ids.add(q.id);
    }
  });

  it('各質問は 2 つ以上の選択肢を持ち、値が SPEC の許容値に含まれる', () => {
    for (const q of QUESTION_POOL) {
      expect(q.options.length, `${q.axis} の選択肢数`).toBeGreaterThanOrEqual(2);
      const allowed = AXIS_VALUES[q.axis as keyof typeof AXIS_VALUES] as readonly string[] | undefined;
      if (!allowed) continue;
      for (const opt of q.options) {
        expect(allowed, `${q.axis}="${opt.value}"`).toContain(opt.value);
      }
    }
  });

  it('genderExpression に「男性」が無い（ハードフィルタで生き残れない値のため）', () => {
    const q = QUESTION_POOL.find((x) => x.axis === 'genderExpression');
    expect(q).toBeDefined();
    expect(q!.options.map((o) => o.value)).not.toContain('男性');
  });

  it('必須 8 軸を全てカバーする', () => {
    const poolAxes = new Set(QUESTION_POOL.map((q) => q.axis));
    for (const axis of REQUIRED_AXES) {
      expect(poolAxes.has(axis), `${axis} が質問プールに無い`).toBe(true);
    }
  });
});

describe('C. 推薦エンジン', () => {
  it('C1: 固定の回答セットに対し決定論的な上位 N を返す', () => {
    const fixedAnswers = runInterview(dataset, (q) => q.options[0].value);
    const first = recommend(fixedAnswers, dataset);
    const second = recommend(fixedAnswers, dataset);

    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(first.length).toBeLessThanOrEqual(5);

    const scores = first.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));

    // 変化検知用。id とスコアだけを固定する（表示文言の変更で落ちないように）。
    expect(first.map((r) => ({ id: r.character.id, score: r.score }))).toMatchSnapshot();
  });

  it('C2: 返るキャラの供給量ランクが全て「僅少」以上', () => {
    const rand = mulberry32(20260720);
    for (let i = 0; i < 200; i += 1) {
      const results = recommend(randomInterview(dataset, rand), dataset);
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
      const answers = randomInterview(dataset, rand);
      if (recommend(answers, dataset).length === 0) empties.push(answers);
    }
    expect(empties).toEqual([]);
  });

  it('C4: 全問「こだわらない」でも結果が空にならない', () => {
    const answers = runInterview(dataset, () => null);
    const results = recommend(answers, dataset);
    expect(results.length).toBeGreaterThan(0);
  });

  it('C5: 各結果に根拠が 1 つ以上付く', () => {
    const rand = mulberry32(31337);
    for (let i = 0; i < 200; i += 1) {
      const results = recommend(randomInterview(dataset, rand), dataset);
      for (const r of results) {
        expect(r.reasons.length, `${r.character.id} に根拠が無い`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('C5: 軸の根拠は実際に一致した軸だけを挙げる（根拠の捏造を弾く）', () => {
    const rand = mulberry32(4242);
    for (let i = 0; i < 200; i += 1) {
      const answers = randomInterview(dataset, rand);
      for (const r of recommend(answers, dataset)) {
        for (const reason of r.reasons) {
          if (reason.kind !== 'axis') continue;
          const answered = answers[reason.axis];
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

  it('C7: 性別表現「男性」または provisional のキャラが結果にも「おまかせ」にも出ない', () => {
    // 実データの既知3体: 男性2体 + ゲーム未実装で provisional な1体。
    const EXCLUDED_IDS = ['aot-levi', 'onepiece-zoro', 'azurlane-yamato'];

    const rand = mulberry32(777);
    for (let i = 0; i < 200; i += 1) {
      const results = recommend(randomInterview(dataset, rand), dataset);
      for (const id of EXCLUDED_IDS) {
        expect(results.some((r) => r.character.id === id), `${id} が推薦に出た`).toBe(false);
      }
    }

    for (let seed = 0; seed < 50; seed += 1) {
      const results = omakase(dataset, { seed });
      for (const id of EXCLUDED_IDS) {
        expect(results.some((r) => r.character.id === id), `${id} がおまかせに出た`).toBe(false);
      }
    }
  });

  it('C8: 次の質問は未質問の軸から選ばれ、同じ軸を 2 回聞かない', () => {
    const answers: Answers = {};
    const asked: AxisKey[] = [];
    const seenAxes = new Set<AxisKey>();
    for (let guard = 0; guard <= MAX_QUESTIONS; guard += 1) {
      const q = nextQuestion(dataset, answers, asked);
      if (!q) break;
      expect(seenAxes.has(q.axis), `${q.axis} を2回聞いた`).toBe(false);
      seenAxes.add(q.axis);
      answers[q.axis] = q.options[0].value;
      asked.push(q.axis);
    }
    expect(seenAxes.size).toBeGreaterThan(0);
  });

  it('C8: askedAxes に含まれる軸は候補から除外される', () => {
    const first = nextQuestion(dataset, {}, []);
    expect(first).not.toBeNull();
    const second = nextQuestion(dataset, {}, [first!.axis]);
    expect(second?.axis).not.toBe(first!.axis);
  });

  it('C9: 候補が1つの値に偏っている軸より、二分できる軸が優先して選ばれる', () => {
    // combat: 4/4 均衡（H=1.0）、affiliationKind: 7/1 偏り（H≈0.544）、他は全軸固定（H=0）。
    const characters = Array.from({ length: 8 }, (_, i) =>
      makeSyntheticCharacter(`c9-${i}`, {
        combat: i < 4 ? '戦う' : '戦わない',
        affiliationKind: i < 7 ? '学生' : '社会人',
      }),
    );
    const supply: SupplyFile = Object.fromEntries(characters.map((c) => [c.id, syntheticSupplyEntry()]));
    const fx: Dataset = { characters, supply };

    const q = nextQuestion(fx, {}, []);
    expect(q?.axis).toBe('combat');
  });

  it('C9/C10: エントロピーが同点なら AXIS_PRIORITY の優先順位で決まる', () => {
    // combat も bust も 4/4 均衡（同じ H=1.0）にする。優先順位配列では bust の方が先。
    const characters = Array.from({ length: 8 }, (_, i) =>
      makeSyntheticCharacter(`c9tie-${i}`, {
        combat: i < 4 ? '戦う' : '戦わない',
        bust: i < 4 ? '標準' : '大きい',
      }),
    );
    const supply: SupplyFile = Object.fromEntries(characters.map((c) => [c.id, syntheticSupplyEntry()]));
    const fx: Dataset = { characters, supply };

    const q = nextQuestion(fx, {}, []);
    expect(q?.axis).toBe('bust');
  });

  it('C10: 同じ (dataset, answers, askedAxes) なら nextQuestion が同じ結果を返す', () => {
    const a = nextQuestion(dataset, {}, []);
    const b = nextQuestion(dataset, {}, []);
    expect(b?.axis).toBe(a?.axis);

    // 同じ回答列なら同じ質問列になる。
    const seq1 = Object.keys(runInterview(dataset, (q) => q.options[0].value));
    const seq2 = Object.keys(runInterview(dataset, (q) => q.options[0].value));
    expect(seq2).toEqual(seq1);
  });

  it('C11: 属性が全て空欄のキャラ・供給エントリが無いキャラが混ざっても選択・推薦が落ちない', () => {
    const normal = Array.from({ length: 4 }, (_, i) =>
      makeSyntheticCharacter(`c11-normal-${i}`, { combat: i < 2 ? '戦う' : '戦わない' }),
    );
    // 必須8軸を含む全軸を空欄にする（zodのA4は通らないが、エンジンはロバストであるべき。
    // SPEC 6.1「供給先行・属性は後追い」の将来シナリオに対する防御的なテスト）。
    const blank = ['c11-blank-0', 'c11-blank-1'].map((id) =>
      makeSyntheticCharacter(id, {
        genderExpression: null,
        ageFeel: null,
        build: null,
        bust: null,
        personality: null,
        hairColor: null,
        combat: null,
        affiliationKind: null,
      }),
    );
    const noSupplyEntry = makeSyntheticCharacter('c11-no-supply');

    const withSupply = [...normal, ...blank];
    const supply: SupplyFile = Object.fromEntries(withSupply.map((c) => [c.id, syntheticSupplyEntry()]));
    // c11-no-supply は意図的に supply に含めない（「なし」扱いでハードフィルタされる想定）。
    const fx: Dataset = { characters: [...withSupply, noSupplyEntry], supply };

    expect(() => {
      const answers: Answers = {};
      const asked: AxisKey[] = [];
      for (let guard = 0; guard <= MAX_QUESTIONS; guard += 1) {
        const q = nextQuestion(fx, answers, asked);
        if (!q) break;
        answers[q.axis] = q.options[0].value;
        asked.push(q.axis);
      }
    }).not.toThrow();

    const results = recommend({}, fx);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(Number.isFinite(r.score), `${r.character.id} のスコアが不正な数値`).toBe(true);
      expect(r.character.id).not.toBe('c11-no-supply');
    }
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
