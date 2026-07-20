import { describe, expect, it } from 'vitest';

import type { Character, SupplyFile } from '../src/data/schema';
import {
  buildProbePool,
  selectProbe,
  HARD_CAP,
  MIN_GAIN,
  MIN_QUESTIONS,
  type Confidence,
  type Probe,
} from '../src/engine/questions';
import {
  nextProbe,
  omakase,
  scoreCharacters,
  shouldGuess,
  topGuess,
  type AnswerMap,
  type Dataset,
  type Reason,
  type Scored,
} from '../src/engine/recommend';
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

/** プローブ1つへの回答を決める戦略。 */
type Strategy = (probe: Probe) => Confidence;

/** 常に同じ確信度で答える戦略（C4/C13 の「全問わからない」等）。 */
function always(confidence: Confidence): Strategy {
  return () => confidence;
}

/** `target` の実際の属性に沿って正直に yes/no を返す戦略（オラクル）。 */
function oracleFor(target: Character): Strategy {
  return (probe) => {
    const raw = target.axes[probe.axis];
    const has = probe.multi ? Array.isArray(raw) && raw.includes(probe.value) : raw === probe.value;
    return has ? 'yes' : 'no';
  };
}

/**
 * `nextProbe` / `scoreCharacters` / `shouldGuess` / `topGuess` を実際の推測ループと
 * 同じ短絡条件（probe===null または shouldGuess）で最後まで駆動する。
 * `src/hooks/useInterview.ts` の reducer の 'answer' 分岐と同じ構造 — 本番と
 * 別のロジックをテスト側に再実装して食い違うことを避けるため、意図的に揃えてある。
 */
function runToGuess(
  dataset: Dataset,
  strategy: Strategy,
  opts?: { exclude?: ReadonlySet<string> },
): { guess: Scored; answers: AnswerMap; askedKeys: Set<string> } {
  const answers: AnswerMap = {};
  const askedKeys = new Set<string>();
  for (let guard = 0; guard <= HARD_CAP + 2; guard += 1) {
    const probe = nextProbe(dataset, answers, askedKeys, opts);
    const scored = scoreCharacters(answers, dataset, opts);
    if (probe === null || shouldGuess(scored, askedKeys.size, probe !== null)) {
      return { guess: topGuess(scored), answers, askedKeys };
    }
    answers[probe.key] = strategy(probe);
    askedKeys.add(probe.key);
  }
  throw new Error('runToGuess: ガードを超えた（無限ループの疑い）');
}

/**
 * C9/C10/MIN_GAIN 用の合成キャラを作る。既定値は全軸固定（エントロピー 0）に
 * しておき、テストごとに狙った軸だけ分布を作る。
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
    imagePath: null,
    imageApproved: false,
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

describe('プローブプール（SPEC 2.4）', () => {
  it('プローブの key が一意で、フォーマットが単一値=/複数値~に従う', () => {
    const pool = buildProbePool(dataset.characters);
    expect(pool.length).toBeGreaterThan(0);

    const seen = new Set<string>();
    for (const probe of pool) {
      expect(seen.has(probe.key), `${probe.key} が重複`).toBe(false);
      seen.add(probe.key);
      const sep = probe.multi ? '~' : '=';
      expect(probe.key).toBe(`${probe.axis}${sep}${probe.value}`);
    }
  });

  it('全プローブの値が SPEC 2.3 の許容値リストに含まれる', () => {
    const pool = buildProbePool(dataset.characters);
    for (const probe of pool) {
      const allowed = AXIS_VALUES[probe.axis as keyof typeof AXIS_VALUES] as readonly string[] | undefined;
      if (!allowed) continue; // affiliationName は自由記述（helpers/data.ts の A5 対象外と同じ扱い）
      expect(allowed, `${probe.axis}="${probe.value}"`).toContain(probe.value);
    }
  });

  it('multi フラグが軸の実際の型（配列かどうか）と一致する', () => {
    const pool = buildProbePool(dataset.characters);
    for (const probe of pool) {
      expect(probe.multi, probe.axis).toBe((MULTI_AXES as readonly string[]).includes(probe.axis));
    }
  });

  it('必須8軸それぞれについて、実データ内に少なくとも1つのプローブが存在する', () => {
    const pool = buildProbePool(dataset.characters);
    const poolAxes = new Set(pool.map((p) => p.axis));
    for (const axis of REQUIRED_AXES) {
      expect(poolAxes.has(axis), `${axis} のプローブが無い`).toBe(true);
    }
  });

  it('MIN_GAIN 未満のエントロピーしか持たないプローブは selectProbe が選ばない', () => {
    // 1/20 の偏り。H = -0.05*log2(0.05) - 0.95*log2(0.95) ≈ 0.286bit。
    const skew = 1 / 20;
    const entropy = -(skew * Math.log2(skew) + (1 - skew) * Math.log2(1 - skew));
    expect(entropy).toBeLessThan(MIN_GAIN); // このテスト自体の前提（閾値未満であること）を確認

    const characters = Array.from({ length: 20 }, (_, i) =>
      makeSyntheticCharacter(`gain-${i}`, { combat: i === 0 ? '戦わない' : '戦う' }),
    );
    expect(selectProbe(characters, new Set())).toBeNull();
  });
});

describe('C. 推薦エンジン', () => {
  it('C1: 固定の回答列に対し決定論的な単一推測を返す', () => {
    const run = () => runToGuess(dataset, always('yes'));
    const first = run();
    const second = run();

    expect(second.guess.character.id).toBe(first.guess.character.id);
    expect(second.guess.score).toBe(first.guess.score);

    // 変化検知用。id とスコアだけを固定する（表示文言の変更で落ちないように）。
    expect({ id: first.guess.character.id, score: first.guess.score }).toMatchSnapshot();
  });

  it('C2: 推測・おまかせで返るキャラの供給量ランクが「なし」でない', () => {
    const rand = mulberry32(20260720);
    for (let i = 0; i < 50; i += 1) {
      const target = dataset.characters[Math.floor(rand() * dataset.characters.length)];
      const { guess } = runToGuess(dataset, oracleFor(target));
      expect(guess.supplyRank, guess.character.id).not.toBe('なし');
    }
    for (let seed = 0; seed < 50; seed += 1) {
      const result = omakase(dataset, { seed });
      expect(result.supplyRank, result.character.id).not.toBe('なし');
    }
  });

  it('C3: 無作為な1000通りの回答パスで scoreCharacters が1件も空にならない', () => {
    const rand = mulberry32(1);
    const confidences: Confidence[] = ['yes', 'probably_yes', 'unknown', 'probably_no', 'no'];
    const empties: AnswerMap[] = [];

    for (let i = 0; i < 1000; i += 1) {
      const answers: AnswerMap = {};
      const askedKeys = new Set<string>();
      for (let q = 0; q < 8; q += 1) {
        const probe = nextProbe(dataset, answers, askedKeys);
        if (!probe) break;
        answers[probe.key] = confidences[Math.floor(rand() * confidences.length)];
        askedKeys.add(probe.key);
      }
      if (scoreCharacters(answers, dataset).length === 0) empties.push(answers);
    }
    expect(empties).toEqual([]);
  });

  it('C4: 全問「わからない」でも scoreCharacters の結果が空にならない', () => {
    const { answers } = runToGuess(dataset, always('unknown'));
    expect(scoreCharacters(answers, dataset).length).toBeGreaterThan(0);
  });

  it('C5: 推測に付く根拠は実際に一致した特性だけを挙げる（根拠の捏造を弾く）', () => {
    const rand = mulberry32(4242);
    for (let i = 0; i < 100; i += 1) {
      const target = dataset.characters[Math.floor(rand() * dataset.characters.length)];
      const { guess } = runToGuess(dataset, oracleFor(target));

      const traitReasons = guess.reasons.filter(
        (r): r is Extract<Reason, { kind: 'trait' }> => r.kind === 'trait',
      );
      for (const reason of traitReasons) {
        const raw = guess.character.axes[reason.axis];
        const matched = Array.isArray(raw) ? raw.includes(reason.value) : raw === reason.value;
        expect(matched, `${guess.character.id} は ${reason.axis}=${reason.value} に一致しない`).toBe(true);
      }
      expect(guess.reasons.some((r) => r.kind === 'supply'), '供給量の根拠が無い').toBe(true);
    }
  });

  it('C6: おまかせがシード固定時に再現可能な単一結果を返す', () => {
    const a = omakase(dataset, { seed: 12345 });
    const b = omakase(dataset, { seed: 12345 });
    expect(b.character.id).toBe(a.character.id);
  });

  it('C6: おまかせは供給量「少ない」以上のみを返す', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const result = omakase(dataset, { seed });
      expect(
        supplyRankIndex(result.supplyRank),
        `${result.character.id} の供給量ランクが ${result.supplyRank}`,
      ).toBeGreaterThanOrEqual(supplyRankIndex('少ない'));
    }
  });

  it('C6: シードが違えば選ばれるキャラも変わりうる（乱択が効いている）', () => {
    const ids = new Set(Array.from({ length: 30 }, (_, seed) => omakase(dataset, { seed }).character.id));
    // 全シードで同一結果 = 乱択が効いていない。
    expect(ids.size).toBeGreaterThan(1);
  });

  it('C7: 性別表現「男性」または provisional のキャラが推測にも「おまかせ」にも出ない', () => {
    // 実データの既知3体: 男性2体 + ゲーム未実装で provisional な1体。
    const EXCLUDED_IDS = ['aot-levi', 'onepiece-zoro', 'azurlane-yamato'];

    const rand = mulberry32(777);
    for (let i = 0; i < 100; i += 1) {
      const target = dataset.characters[Math.floor(rand() * dataset.characters.length)];
      const { guess } = runToGuess(dataset, oracleFor(target));
      expect(EXCLUDED_IDS, `${guess.character.id} が推測に出た`).not.toContain(guess.character.id);
    }

    for (let seed = 0; seed < 50; seed += 1) {
      const result = omakase(dataset, { seed });
      expect(EXCLUDED_IDS, `${result.character.id} がおまかせに出た`).not.toContain(result.character.id);
    }
  });

  it('C8: nextProbe は askedKeys に無いプローブから選ばれ、同じプローブを2回聞かない', () => {
    const answers: AnswerMap = {};
    const askedKeys = new Set<string>();
    const seen = new Set<string>();
    for (let guard = 0; guard <= HARD_CAP; guard += 1) {
      const probe = nextProbe(dataset, answers, askedKeys);
      if (!probe) break;
      expect(seen.has(probe.key), `${probe.key} を2回聞いた`).toBe(false);
      seen.add(probe.key);
      answers[probe.key] = 'yes';
      askedKeys.add(probe.key);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('C8: askedKeys に含まれるプローブは候補から除外される', () => {
    const first = nextProbe(dataset, {}, new Set());
    expect(first).not.toBeNull();
    const second = nextProbe(dataset, {}, new Set([first!.key]));
    expect(second?.key).not.toBe(first!.key);
  });

  it('C9: 候補が1つの値に偏ったプローブより、二分できるプローブが優先して選ばれる', () => {
    // combat: 4/4 均衡（H=1.0）、affiliationKind: 7/1 偏り（H≈0.544）、他は全軸固定（H=0）。
    const characters = Array.from({ length: 8 }, (_, i) =>
      makeSyntheticCharacter(`c9-${i}`, {
        combat: i < 4 ? '戦う' : '戦わない',
        affiliationKind: i < 7 ? '学生' : '社会人',
      }),
    );
    const probe = selectProbe(characters, new Set());
    expect(probe?.axis).toBe('combat');
  });

  it('C9/C10: エントロピーが同点なら軸の固定優先順位で決まる', () => {
    // combat も bust も 4/4 均衡（同じ H=1.0）にする。軸の固定順では bust の方が先。
    const characters = Array.from({ length: 8 }, (_, i) =>
      makeSyntheticCharacter(`c9tie-${i}`, {
        combat: i < 4 ? '戦う' : '戦わない',
        bust: i < 4 ? '標準' : '大きい',
      }),
    );
    const probe = selectProbe(characters, new Set());
    expect(probe?.axis).toBe('bust');
  });

  it('C10: 同じ (population, askedKeys) なら selectProbe が同じ結果を返す', () => {
    const a = selectProbe(dataset.characters, new Set());
    const b = selectProbe(dataset.characters, new Set());
    expect(b?.key).toBe(a?.key);

    // 同じ回答列（オラクル）なら同じ質問列になる。
    const target = dataset.characters[0];
    const seq1 = [...runToGuess(dataset, oracleFor(target)).askedKeys];
    const seq2 = [...runToGuess(dataset, oracleFor(target)).askedKeys];
    expect(seq2).toEqual(seq1);
  });

  it('C11: 属性が全て空欄のキャラ・供給エントリが無いキャラが混ざっても質問選択・スコアリングが落ちない', () => {
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

    expect(() => runToGuess(fx, always('yes'))).not.toThrow();

    const results = scoreCharacters({}, fx);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(Number.isFinite(r.score), `${r.character.id} のスコアが不正な数値`).toBe(true);
      expect(r.character.id).not.toBe('c11-no-supply');
    }
  });

  it('C11: 空欄の軸は確信度に関わらずスコアに寄与しない（3値式）', () => {
    const blankChar = makeSyntheticCharacter('c11-contribution-blank', { mood: null });
    const filledChar = makeSyntheticCharacter('c11-contribution-filled', { mood: '甘め' });
    const characters = [blankChar, filledChar];
    const supply: SupplyFile = Object.fromEntries(characters.map((c) => [c.id, syntheticSupplyEntry()]));
    const fx: Dataset = { characters, supply };

    const probe = buildProbePool([filledChar]).find((p) => p.axis === 'mood' && p.value === '甘め');
    expect(probe).toBeDefined();

    for (const confidence of ['yes', 'probably_yes', 'probably_no', 'no'] as const) {
      const scored = scoreCharacters({ [probe!.key]: confidence }, fx);
      const blankScore = scored.find((s) => s.character.id === 'c11-contribution-blank')?.score;
      expect(blankScore, `confidence=${confidence}`).toBe(0);
    }
  });

  it('C12: askedCount < MIN_QUESTIONS の間 shouldGuess は常に false を返す', () => {
    const scoredHuge: Scored[] = [
      { character: dataset.characters[0], score: 1000, supplyRank: '豊富', reasons: [] },
      { character: dataset.characters[1], score: -1000, supplyRank: '豊富', reasons: [] },
    ];
    for (let askedCount = 0; askedCount < MIN_QUESTIONS; askedCount += 1) {
      // 極端なスコア差・情報量なしでも、floor未満なら常に false。
      expect(shouldGuess(scoredHuge, askedCount, false)).toBe(false);
    }
  });

  it('C12: 「いいえ」で拒否したキャラは以降の scoreCharacters/nextProbe から除外される', () => {
    const target = dataset.characters.find((c) => c.axes.genderExpression !== '男性' && c.provisional !== true)!;
    const { guess, answers } = runToGuess(dataset, oracleFor(target));

    let rejected = new Set<string>([guess.character.id]);
    let rescored = scoreCharacters(answers, dataset, { exclude: rejected });
    expect(rescored.some((s) => s.character.id === guess.character.id)).toBe(false);
    expect(rescored.length).toBeGreaterThan(0);

    // 累積的に拒否を続けても、拒否済み全員が常に除外され続ける。
    for (let i = 0; i < 5 && rescored.length > 0; i += 1) {
      rejected = new Set([...rejected, rescored[0].character.id]);
      rescored = scoreCharacters(answers, dataset, { exclude: rejected });
      for (const id of rejected) {
        expect(rescored.some((s) => s.character.id === id), `${id} が除外されていない`).toBe(false);
      }
    }
  });

  it('C13: 実データ33体全員が、オラクル回答で6問で自分自身に収束する', () => {
    const survivors = dataset.characters.filter(
      (c) => c.axes.genderExpression !== '男性' && c.provisional !== true,
    );
    const askedCounts: number[] = [];
    const failures: string[] = [];

    for (const target of survivors) {
      const { guess, askedKeys } = runToGuess(dataset, oracleFor(target));
      askedCounts.push(askedKeys.size);
      if (guess.character.id !== target.id) {
        failures.push(`${target.id}: guessed=${guess.character.id} after ${askedKeys.size}問`);
      }
    }

    expect(failures).toEqual([]);
    expect(Math.min(...askedCounts)).toBe(MIN_QUESTIONS);
    expect(Math.max(...askedCounts)).toBe(MIN_QUESTIONS);
  });

  it('C13: 全問「わからない」の場合は HARD_CAP で強制的に推測へ進む', () => {
    const { askedKeys } = runToGuess(dataset, always('unknown'));
    expect(askedKeys.size).toBe(HARD_CAP);
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
