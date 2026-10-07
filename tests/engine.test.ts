import { describe, expect, it } from 'vitest';

import type { AxisKey, Character, SupplyFile } from '../src/data/schema';
import {
  AXIS_LABEL,
  PROFILE_ENTRY_LIMIT,
  buildProbePool,
  profileEntriesFor,
  selectProbe,
  HARD_CAP,
  MIN_GAIN,
  MIN_QUESTIONS,
  type Confidence,
  type Probe,
} from '../src/engine/questions';
import {
  BONUS_MAX_QUESTIONS,
  BONUS_MIN_QUESTIONS,
  nextProbe,
  omakase,
  scoreCharacters,
  shouldGuess,
  shouldReguess,
  survivors,
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
  opts?: { exclude?: ReadonlySet<string>; rng?: () => number },
): { guess: Scored; answers: AnswerMap; askedKeys: Set<string>; scored: Scored[] } {
  const answers: AnswerMap = {};
  const askedKeys = new Set<string>();
  for (let guard = 0; guard <= HARD_CAP + 2; guard += 1) {
    const probe = nextProbe(dataset, answers, askedKeys, opts);
    const scored = scoreCharacters(answers, dataset, opts);
    if (probe === null || shouldGuess(scored, askedKeys.size, probe !== null)) {
      return { guess: topGuess(scored, opts?.rng), answers, askedKeys, scored };
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
    // 合成フィクスチャは常に査読済み扱いにする（survivors()のreviewedハードフィルタで
    // 除外されないように。C11等はスコアリングの頑健性を見るテストで、reviewedゲート
    // 自体を検証する対象ではない）。
    reviewed: true,
    provisional: false,
    imagePath: null,
    imageApproved: false,
    axes: {
      genderExpression: '女性',
      ageFeel: '同年代',
      build: '標準',
      bust: '標準',
      personality: ['クール'],
      roles: [],
      distance: null,
      looks: [],
      hairColor: ['黒'],
      skinTone: null,
      outfit: [],
      species: null,
      mood: [],
      combat: '戦う',
      affiliationKind: '学生',
      affiliationName: null,
      stature: null,
      occupation: [],
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
    // topGuess()の同点タイブレークは既定でMath.random()を使う（C13の2026-08-02
    // コメント参照）。always('yes')の全問一致では複数キャラが同点最高スコアに
    // 達し得るため、rngを固定しないとこのテスト自体が非決定的になる。
    const run = () => runToGuess(dataset, always('yes'), { rng: mulberry32(20260803) });
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
  },
  // 1008体にした全体実行で約7秒かかり、既定の5秒を超えた(2026-10-07 実測)。
  60000);

  it(
    'C3: 無作為な1000通りの回答パスで scoreCharacters が1件も空にならない',
    () => {
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
    },
    // 他のテストファイル（tests/engine-bias.test.ts 等）と並列実行された際の
    // CPU競合でデフォルト5秒を超えることがあるため明示的に緩める
    // （2026-07-21、engine-bias.test.ts追加後に確認。20秒でも並列実行時に
    // 超えることがあったため、実測の数倍のヘッドルームを持たせる）。
    // 1008体にした全体実行で約73秒かかり60秒を超えた(2026-10-07 実測)ため300秒にする。
    300000,
  );

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
  },
  // Windows 機（Node 25）では単体でも約5.5秒かかり、既定の5秒を超えて止まっていた
  // （2026-10-04 実測）。並列実行時はさらに延びるため、C3 と同じ60秒にそろえる。
  60000);

  describe('C15: profileEntriesFor（推測・結果画面のプロフィール表示）', () => {
    it('単一値軸も複数値軸も values 配列に揃えて返す', () => {
      const c = makeSyntheticCharacter('c15-shape', {
        species: '人間',
        occupation: ['忍者', '海賊'],
      });
      const entries = profileEntriesFor(c);
      const byAxis = new Map(entries.map((e) => [e.axis, e]));
      expect(byAxis.get('species')?.values).toEqual(['人間']);
      expect(byAxis.get('occupation')?.values).toEqual(['忍者', '海賊']);
      for (const e of entries) expect(Array.isArray(e.values)).toBe(true);
    });

    it('空欄（null・空配列）の軸は出さない', () => {
      const c = makeSyntheticCharacter('c15-empty', {
        species: null,
        occupation: [],
        affiliationName: null,
      });
      const axes = profileEntriesFor(c, { limit: 99 }).map((e) => e.axis);
      expect(axes).not.toContain('species');
      expect(axes).not.toContain('occupation');
      expect(axes).not.toContain('affiliationName');
    });

    it('胸のサイズは値があっても出さない（プロフィール非表示軸）', () => {
      const c = makeSyntheticCharacter('c15-bust', { bust: 'とても大きい' });
      const axes = profileEntriesFor(c, { limit: 99 }).map((e) => e.axis);
      expect(axes).not.toContain('bust');
    });

    it('exclude に渡した軸は出さない（根拠として既に表示済みの軸の重複を避ける）', () => {
      const c = makeSyntheticCharacter('c15-exclude', { species: '人間', personality: ['クール'] });
      const axes = profileEntriesFor(c, { exclude: new Set<AxisKey>(['species']), limit: 99 }).map((e) => e.axis);
      expect(axes).not.toContain('species');
      expect(axes).toContain('personality');
    });

    it('既定で PROFILE_ENTRY_LIMIT 件までに絞り、固有性の高い軸を先に出す', () => {
      const c = makeSyntheticCharacter('c15-limit', {
        affiliationName: 'ミレニアムサイエンススクール（C&C）',
        occupation: ['忍者'],
        species: '人間',
      });
      const entries = profileEntriesFor(c);
      expect(entries.length).toBeLessThanOrEqual(PROFILE_ENTRY_LIMIT);
      // 所属名→職業→種族 の順（PROFILE_AXIS_ORDER の先頭3つ）で始まる。
      expect(entries.slice(0, 3).map((e) => e.axis)).toEqual(['affiliationName', 'occupation', 'species']);
    });

    it('label は AXIS_LABEL と一致する', () => {
      const c = makeSyntheticCharacter('c15-label', { species: '人間' });
      const species = profileEntriesFor(c, { limit: 99 }).find((e) => e.axis === 'species');
      expect(species?.label).toBe(AXIS_LABEL.species);
    });
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
  },
  // C5 と同じ理由（Windows 機で既定の5秒を超えていた。2026-10-04 実測）。
  60000);

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

  it('C10: rng を指定すると僅差の上位候補から乱択され、同じ rng シードなら再現可能', () => {
    // combat/bust/personality を横並びの均衡分布(H=1.0近辺)にし、上位候補が複数生まれる状況を作る。
    const characters = Array.from({ length: 8 }, (_, i) =>
      makeSyntheticCharacter(`c10rng-${i}`, {
        combat: i < 4 ? '戦う' : '戦わない',
        bust: i < 4 ? '標準' : '大きい',
        personality: i < 4 ? ['クール'] : ['元気'],
      }),
    );

    const withoutRng = selectProbe(characters, new Set());
    // rng省略時は常に同じ（決定論、C10前段と同じ契約）。
    expect(selectProbe(characters, new Set())?.key).toBe(withoutRng?.key);

    // rngを固定すれば毎回同じ結果、rngが違えば異なる候補が選ばれ得る。
    const seen = new Set<string>();
    for (let seed = 0; seed < 20; seed += 1) {
      const rng = mulberry32(seed);
      const a = selectProbe(characters, new Set(), rng);
      const b = selectProbe(characters, new Set(), mulberry32(seed));
      expect(b?.key).toBe(a?.key); // 同じシードなら再現可能
      if (a) seen.add(a.key);
    }
    expect(seen.size).toBeGreaterThan(1); // シードを変えれば異なる候補も選ばれる
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
        personality: [],
        hairColor: [],
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

  it('C11: 空欄の軸は「はい」方向の確信度ではスコアに寄与しない（3値式）', () => {
    const blankChar = makeSyntheticCharacter('c11-contribution-blank', { mood: [] });
    const filledChar = makeSyntheticCharacter('c11-contribution-filled', { mood: ['甘め'] });
    const characters = [blankChar, filledChar];
    const supply: SupplyFile = Object.fromEntries(characters.map((c) => [c.id, syntheticSupplyEntry()]));
    const fx: Dataset = { characters, supply };

    const probe = buildProbePool([filledChar]).find((p) => p.axis === 'mood' && p.value === '甘め');
    expect(probe).toBeDefined();

    for (const confidence of ['yes', 'probably_yes'] as const) {
      const scored = scoreCharacters({ [probe!.key]: confidence }, fx);
      const blankScore = scored.find((s) => s.character.id === 'c11-contribution-blank')?.score;
      expect(blankScore, `confidence=${confidence}`).toBe(0);
    }
  });

  it('C11: 空欄の軸は「いいえ」方向では、その値を持たない非空欄キャラと同じだけ加点される', () => {
    // 実データのC13で発見した不具合（utau-teto/kanokari-chizuruが無関係な
    // キャラに誤収束）の再発防止用。空欄を常に0のままにすると、対象キャラが
    // 空欄の軸で複数の値を連続して尋ねられたとき、その軸に何らかの値を持つ
    // 無関係な他キャラだけが「該当しない」加点を積み重ねて逆転できてしまう。
    const blankChar = makeSyntheticCharacter('c11-contribution-blank2', { mood: [] });
    const otherValueChar = makeSyntheticCharacter('c11-contribution-other', { mood: ['支配的'] });
    const matchingChar = makeSyntheticCharacter('c11-contribution-matching', { mood: ['甘め'] });
    const characters = [blankChar, otherValueChar, matchingChar];
    const supply: SupplyFile = Object.fromEntries(characters.map((c) => [c.id, syntheticSupplyEntry()]));
    const fx: Dataset = { characters, supply };

    const probe = buildProbePool([matchingChar]).find((p) => p.axis === 'mood' && p.value === '甘め');
    expect(probe).toBeDefined();

    for (const confidence of ['probably_no', 'no'] as const) {
      const scored = scoreCharacters({ [probe!.key]: confidence }, fx);
      const blankScore = scored.find((s) => s.character.id === 'c11-contribution-blank2')?.score;
      const otherScore = scored.find((s) => s.character.id === 'c11-contribution-other')?.score;
      expect(blankScore, `confidence=${confidence}`).not.toBe(0);
      expect(blankScore, `confidence=${confidence}`).toBe(otherScore);
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

  describe('C14: shouldReguess（「いいえ」後の再質問）', () => {
    // 1位と2位が MARGIN_STOP 以上離れている＝確信あり。
    const confident: Scored[] = [
      { character: dataset.characters[0], score: 1000, supplyRank: '豊富', reasons: [] },
      { character: dataset.characters[1], score: 0, supplyRank: '豊富', reasons: [] },
    ];
    // 1位と2位が僅差＝確信なし。
    const unsure: Scored[] = [
      { character: dataset.characters[0], score: 10, supplyRank: '豊富', reasons: [] },
      { character: dataset.characters[1], score: 9, supplyRank: '豊富', reasons: [] },
    ];

    it('BONUS_MIN_QUESTIONS 未満の間は、どれだけ確信があっても false（最低問数を必ず聞く）', () => {
      for (let n = 0; n < BONUS_MIN_QUESTIONS; n += 1) {
        expect(shouldReguess(confident, n, true), `questionsSinceReject=${n}`).toBe(false);
      }
    });

    it('BONUS_MIN_QUESTIONS 以降は確信の有無で決まる', () => {
      expect(shouldReguess(confident, BONUS_MIN_QUESTIONS, true)).toBe(true);
      expect(shouldReguess(unsure, BONUS_MIN_QUESTIONS, true)).toBe(false);
    });

    it('BONUS_MAX_QUESTIONS に達したら確信が無くても true（だらだら続けない）', () => {
      expect(shouldReguess(unsure, BONUS_MAX_QUESTIONS - 1, true)).toBe(false);
      expect(shouldReguess(unsure, BONUS_MAX_QUESTIONS, true)).toBe(true);
      expect(shouldReguess(unsure, BONUS_MAX_QUESTIONS + 5, true)).toBe(true);
    });

    it('聞くべき質問が尽きたら、最低問数を待たず即座に true（存在しない質問は表示できない）', () => {
      expect(shouldReguess(unsure, 0, false)).toBe(true);
    });

    it('候補が1体しか残っていなければ、最低問数の後は常に true（比較相手がいない）', () => {
      const only: Scored[] = [{ character: dataset.characters[0], score: 1, supplyRank: '豊富', reasons: [] }];
      expect(shouldReguess(only, BONUS_MIN_QUESTIONS, true)).toBe(true);
      expect(shouldReguess(only, BONUS_MIN_QUESTIONS - 1, true)).toBe(false);
    });
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

  it('C13: 実データの生存者全員が、オラクル回答で自分自身（または完全同点の候補）に収束する（MIN_QUESTIONS〜HARD_CAP問の範囲内）', () => {
    // データ拡充で母集団が増えるほど、似た候補が増えて必要質問数の分布は右に伸びる
    // （33体時代は全員ちょうど6問だったが、それは「母集団が小さいから常に floor で
    // 分離しきれる」という当時のデータ規模に固有の性質であり、アルゴリズムの
    // 不変条件ではない）。不変条件として保証されるのは「6問未満では絶対に確定しない・
    // 10問を超えて粘らない」の2点と、「自分自身より真にスコアが高い他キャラに
    // 負けることは無い（完全同点で選ばれなかった場合を除く）」。
    // survivors()を直接使う（以前はここで一部だけ再実装しており、reviewed等の
    // ハードフィルタ追加に追随できていなかった。2026-08-01発覚）。
    //
    // 2026-08-02発見（500体拡張Stage 1 査読キャンペーン完走・reachable 185→488）:
    // topGuess() の同点タイブレークは既定で Math.random() を使う（C10で乱択が
    // 意図的な仕様と確認済み）。母集団が488まで拡大すると、18軸の離散値だけでは
    // HARD_CAP=10問の予算内で分離しきれない「真に完全同点」のキャラペアが実際に
    // 発生するようになった（例: fate-illya/pokemon-lillie系）。runToGuess に
    // 固定seedのrngを渡さず実行していたため、CIごとに毎回違う組み合わせで
    // ランダムに失敗する不安定なゲートになっていた。
    //
    // さらに調査すると、scoreCharacters() のソートは score→supplyRank→id の
    // 3段構成（recommend.ts）で、score が同点でも supplyRank が低いキャラは
    // 決定論的に（乱択を経ずに）2位以下へ落ちる——これはtopGuessのrng起因の
    // 偶然ではなく「同点なら供給量が多い方を優先する」という設計上の意図的な
    // 挙動（該当キャラの絶対数が増えるほど、自分と同点かつ供給量で勝る他キャラが
    // 実在する確率も上がるため、母集団拡大で必然的に頻度が増す）。
    // よって判定基準は「自分自身が到達しうる最高スコアに真に並んでいるか
    // (score一致のみ。supplyRank/idでの最終順位は設計上ずれてよい)」を
    // 「収束」とみなし、真にスコアが自分より高い他キャラに負けた場合だけを
    // 実失敗として扱う——後者だけが実際のアルゴリズム不具合を示す。
    const reachable = survivors(dataset);
    const askedCounts: number[] = [];
    const failures: string[] = [];
    const rng = mulberry32(20260802);

    for (const target of reachable) {
      const { guess, askedKeys, scored } = runToGuess(dataset, oracleFor(target), { rng });
      askedCounts.push(askedKeys.size);
      if (guess.character.id !== target.id) {
        const targetScored = scored.find((s) => s.character.id === target.id);
        const reachedTopScore = targetScored !== undefined && targetScored.score === guess.score;
        if (!reachedTopScore) {
          failures.push(
            `${target.id}: guessed=${guess.character.id} after ${askedKeys.size}問 ` +
              `(target score=${targetScored?.score} vs guess score=${guess.score})`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
    expect(Math.min(...askedCounts)).toBeGreaterThanOrEqual(MIN_QUESTIONS);
    expect(Math.max(...askedCounts)).toBeLessThanOrEqual(HARD_CAP);
  },
    // reachableが488体規模になり、全員ぶんのオラクル収束シミュレーションが
    // vitestのデフォルト5000msを超えるようになった（実測13秒前後）。
    // tests/engine-bias.test.ts/tests/bayes-bias.test.ts と同じ理由で緩める。
    // 1008体にした全体実行で60秒を超えた(2026-10-07)。単体で約127秒かかるので600秒にする。
    600000,
  );

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
