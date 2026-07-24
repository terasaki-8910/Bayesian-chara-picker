import type { AxisKey, Character, SupplyFile } from '../data/schema';
import {
  AXIS_LABEL,
  CONFIDENCE_WEIGHT,
  CONTENTION_M,
  HARD_CAP,
  MIN_QUESTIONS,
  buildProbePool,
  selectProbe,
  type Confidence,
  type Probe,
} from './questions';
import { combinedSupplyRank, hitomiSupplyRank, supplyRank, supplyRankIndex, type SupplyRank } from './supply';

export { HARD_CAP, MIN_QUESTIONS } from './questions';
export type { Confidence, Probe } from './questions';

/** プローブ key（"axis=value" | "axis~value"） -> 確信度。 */
export type AnswerMap = Record<string, Confidence>;

export type Dataset = { characters: Character[]; supply: SupplyFile };

export type Reason =
  | { kind: 'trait'; axis: AxisKey; value: string; label: string; confidence: Confidence }
  | { kind: 'supply'; rank: SupplyRank; label: string };

export type Scored = {
  character: Character;
  score: number;
  supplyRank: SupplyRank;
  reasons: Reason[];
};

/** 特性1つが完全一致/不一致したときの基礎点。 */
export const BASE_SCORE = 20;

/** 推測を確定してよい最小スコア差（特性1つが完全に分離する量）。 */
export const MARGIN_STOP = 2 * BASE_SCORE;

function supplyLabelFor(rank: SupplyRank): string {
  return `供給量: ${rank}`;
}

/**
 * `supply.json` にエントリが無いキャラは「なし」扱いにする（ハードフィルタで除外される）。
 * ベイズエンジン(src/engine/bayes.ts)からも事前分布(V_c)の計算に再利用するため export する
 * （CONTRACT: 既存exportの追加のみ、改名・削除はしない）。
 */
export function combinedRankFor(id: string, supply: SupplyFile): SupplyRank {
  const entry = supply[id];
  if (!entry) return 'なし';
  const ranks: SupplyRank[] = [supplyRank(entry.pageCount)];
  if (entry.hitomi) ranks.push(hitomiSupplyRank(entry.hitomi.galleryCount));
  return combinedSupplyRank(ranks);
}

function isBlank(character: Character, axis: AxisKey): boolean {
  const raw = character.axes[axis];
  if (Array.isArray(raw)) return raw.length === 0;
  return raw === null || raw === undefined || raw === '';
}

function hasTraitValue(character: Character, axis: AxisKey, value: string, multi: boolean): boolean {
  const raw = character.axes[axis];
  return multi ? Array.isArray(raw) && raw.includes(value) : raw === value;
}

/**
 * ハードフィルタ後の全員。`scoreCharacters` はここから嗜好の不一致では誰も落とさず
 * スコアで並べるだけにする（C3 相当: 無作為多数回パスで1件も空にならないことの根拠）。
 * `exclude` は「いいえ」で拒否済みのキャラ id 集合（再推測用。PLAN「拒否ループ」）。
 * ベイズエンジン(src/engine/bayes.ts)からも同じハードフィルタ集合が必要なため export する
 * （CONTRACT: 既存exportの追加のみ、改名・削除はしない）。
 */
export function survivors(dataset: Dataset, exclude?: ReadonlySet<string>): Character[] {
  return dataset.characters.filter(
    (c) =>
      c.axes.genderExpression !== '男性' &&
      c.provisional !== true &&
      combinedRankFor(c.id, dataset.supply) !== 'なし' &&
      !(exclude?.has(c.id) ?? false),
  );
}

/**
 * `AnswerMap` のキー（プローブ key 文字列）から実際の `Probe`（軸・値・multi）を
 * 引くための逆引き表。`dataset.characters` 全体（男性・provisional も含む）から
 * 作る — ハードフィルタで survivors から落ちたキャラにしか実在しない値のキーが
 * 過去に answers へ記録されていても、確実にデコードできるようにするため。
 */
function buildProbeIndex(dataset: Dataset): ReadonlyMap<string, Probe> {
  return new Map(buildProbePool(dataset.characters).map((p) => [p.key, p]));
}

/**
 * 特性1つぶんのスコア寄与。3値式（Planエージェントが指摘したバグの修正版）:
 * 非空欄は、一致なら +w、不一致なら -w（w は確信度の符号付き重み）。
 *
 * 空欄の扱いは方向で非対称にする（実データの C13 で発見した不具合の修正。
 * utau-teto / kanokari-chizuru が無関係なキャラに誤収束していた）:
 * - 「はい」方向（w>0）は常に0（供給先行・属性は後追いという SPEC 6.1 の
 *   保証を守る — 属性未入力のキャラが「はい」回答だけで加点されることはない）。
 * - 「いいえ」方向（w<0）は、非空欄で別の値を持つキャラの「不一致」加点と
 *   同じだけ加点する。「この特定の値は持たない」という事実は空欄でも真であり、
 *   ここを0のままにすると、対象キャラが空欄の軸で複数の値を連続して尋ねられた
 *   ときに、その軸に何らかの値を持つ無関係な他キャラだけが「該当しない」加点を
 *   積み重ねて対象キャラを逆転できてしまう（多値の単一選択軸で顕著）。
 *
 * `has` も一緒に返す — 呼び出し側が「根拠として表示してよいか」を判定するため。
 * `delta > 0` だけでは判定できない: 「いいえ」（w<0）に対して実際に該当しない
 * （has=false）場合も `-w*BASE > 0` になり得るが、これは「不一致という予想が
 * 正しかった」ことによる加点であって、「${axis}=${value}」という特性を実際に
 * 持っているわけではない。この2つを区別せず reasons に積むと、「該当しない」
 * 特性を「該当する」根拠として表示する誤りになる（C5 で検出）。空欄の場合も
 * 同じ理由で常に has=false を返す（「持たない」ことはわかっても「該当する
 * 特性」を持っているわけではないため、根拠には積まない）。
 */
function contribution(
  character: Character,
  probe: Probe,
  confidence: Confidence,
): { delta: number; has: boolean } {
  const w = CONFIDENCE_WEIGHT[confidence];
  if (isBlank(character, probe.axis)) return { delta: w < 0 ? -w * BASE_SCORE : 0, has: false };
  const has = hasTraitValue(character, probe.axis, probe.value, probe.multi);
  return { delta: has ? w * BASE_SCORE : -w * BASE_SCORE, has };
}

/**
 * 全 survivors のスコアを計算する。回答と食い違うキャラも一切除外しない
 * （嗜好はスコアを動かすだけで、候補集合を削らない。空にならない保証の要）。
 * 供給量は加点せず、並び順のタイブレークにのみ使う
 * （PLAN: 単一推測方式ではスコア差が小さくなりうるため、加点式の係数調整より
 * タイブレーク専用にする方が確実で検証しやすい）。
 */
export function scoreCharacters(
  answers: AnswerMap,
  dataset: Dataset,
  opts?: { exclude?: ReadonlySet<string> },
): Scored[] {
  const probeIndex = buildProbeIndex(dataset);
  const entries = Object.entries(answers);

  const results: Scored[] = survivors(dataset, opts?.exclude).map((character) => {
    let score = 0;
    const reasons: Reason[] = [];
    for (const [key, confidence] of entries) {
      const probe = probeIndex.get(key);
      if (!probe) continue; // 未知のキー（不整合な呼び出し）は無視して安全側に倒す
      const { delta, has } = contribution(character, probe, confidence);
      score += delta;
      if (has && delta > 0) {
        reasons.push({
          kind: 'trait',
          axis: probe.axis,
          value: probe.value,
          label: AXIS_LABEL[probe.axis],
          confidence,
        });
      }
    }
    const rank = combinedRankFor(character.id, dataset.supply);
    reasons.push({ kind: 'supply', rank, label: supplyLabelFor(rank) });
    return { character, score, supplyRank: rank, reasons };
  });

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const rankDiff = supplyRankIndex(b.supplyRank) - supplyRankIndex(a.supplyRank);
    if (rankDiff !== 0) return rankDiff;
    return a.character.id < b.character.id ? -1 : a.character.id > b.character.id ? 1 : 0;
  });

  return results;
}

function isConsistent(character: Character, probe: Probe, confidence: Confidence): boolean {
  if (confidence === 'unknown') return true; // 情報量ゼロ = 作業集合を絞らない
  if (isBlank(character, probe.axis)) return true; // 空欄は常に矛盾しない扱い（供給先行方針）
  const has = hasTraitValue(character, probe.axis, probe.value, probe.multi);
  const expectYes = confidence === 'yes' || confidence === 'probably_yes';
  return has === expectYes;
}

/**
 * 質問選択専用の作業集合。survivors のうち、これまでの回答（「わからない」を除く）と
 * 矛盾しないキャラだけに絞る。スコアリングには使わない
 * （母集団を分離するのが動的選択と非空保証を両立させる鍵）。
 * 「たぶんそう/たぶん違う」も yes/no と同じ向きで絞る（弱い確信度でもスコアの重みが
 * 半分になるだけで、質問選択上は無視すべき理由が無いため）。
 */
function workingSet(
  dataset: Dataset,
  answers: AnswerMap,
  probeIndex: ReadonlyMap<string, Probe>,
  exclude?: ReadonlySet<string>,
): Character[] {
  const entries = Object.entries(answers);
  return survivors(dataset, exclude).filter((c) =>
    entries.every(([key, confidence]) => {
      const probe = probeIndex.get(key);
      return probe === undefined || isConsistent(c, probe, confidence);
    }),
  );
}

/**
 * 次に聞くべきプローブを選ぶ（ハイブリッド母集団。PLAN「選択アルゴリズム」）。
 *
 * 通常は確定的な作業集合（今までの回答と矛盾しないキャラ）でプローブを選ぶ。
 * その集合が2体未満に縮んだ、または作業集合内に情報量のあるプローブが
 * 尽きた場合は、スコア上位 `CONTENTION_M` 体の「接戦集合」に母集団を切り替えて
 * 選び直す。実データ33体のシミュレーションで、この切り替えが無いと5問前後で
 * 作業集合が1体に収束してしまい、`MIN_QUESTIONS`（6問）に届く前に
 * 「聞くべき質問が無い」状態に陥ることを確認済み。
 */
export function nextProbe(
  dataset: Dataset,
  answers: AnswerMap,
  askedKeys: ReadonlySet<string>,
  opts?: { exclude?: ReadonlySet<string>; rng?: () => number },
): Probe | null {
  const probeIndex = buildProbeIndex(dataset);
  const working = workingSet(dataset, answers, probeIndex, opts?.exclude);

  if (working.length >= 2) {
    const probe = selectProbe(working, askedKeys, opts?.rng);
    if (probe !== null) return probe;
  }

  const contention = scoreCharacters(answers, dataset, opts)
    .slice(0, CONTENTION_M)
    .map((s) => s.character);
  return selectProbe(contention, askedKeys, opts?.rng);
}

/**
 * 推測を提示してよいかどうか（PLAN「推測・拒否・再推測・全滅の具体的なルール」1.）。
 * `askedCount >= MIN_QUESTIONS` かつ、以下のいずれかを満たすこと:
 *   - `askedCount` が `HARD_CAP` に達した（情報量に関わらず強制打ち切り）
 *   - 1位と2位のスコア差が `MARGIN_STOP` 以上
 *   - 情報量のあるプローブがもう残っていない（`hasInformativeProbe===false`）
 */
export function shouldGuess(scored: readonly Scored[], askedCount: number, hasInformativeProbe: boolean): boolean {
  if (askedCount < MIN_QUESTIONS) return false;
  if (askedCount >= HARD_CAP) return true;
  if (scored.length < 2) return true;
  if (!hasInformativeProbe) return true;
  return scored[0].score - scored[1].score >= MARGIN_STOP;
}

/**
 * 決定論的な推測 + 同点のみ乱択。`scored` は `scoreCharacters` の出力
 * （既に (score DESC, supplyRankIndex DESC, id ASC) でソート済み）を渡す想定。
 * タイブレークは「供給量→乱択」（PLAN 規則6: 全問「わからない」なら全員スコア0で
 * 並ぶため、この経路がそのまま「複数該当したらランダムに見せる」を実現する）。
 */
export function topGuess(scored: readonly Scored[], rng: () => number = Math.random): Scored {
  if (scored.length === 0) {
    throw new Error('topGuess: scored は空にできない（survivors が空ならデータ不整合）');
  }
  const top = scored[0];
  const tied = scored.filter((s) => s.score === top.score && s.supplyRank === top.supplyRank);
  if (tied.length === 1) return tied[0];
  const idx = Math.min(Math.floor(rng() * tied.length), tied.length - 1);
  return tied[idx];
}

/**
 * 標準的な mulberry32 疑似乱数生成器。依存を増やさないための自前実装
 * （bryc 版として広く知られるアルゴリズム）。同じ seed からは常に同じ数列を返す。
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 重み付き復元抽出1件ぶん。重み0のキャラも僅かに選ばれ得るよう下駄を履かせる。 */
function weightedPick(items: readonly Character[], weights: readonly number[], rand: () => number): Character {
  const total = weights.reduce((sum, w) => sum + Math.max(w, 0.0001), 0);
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= Math.max(weights[i], 0.0001);
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * 質問・確認ループを経ない独立経路。供給量「少ない」以上から供給量で重み付けした
 * 乱択で単一結果を返す。id 昇順にソートしてから抽選するため、同じ seed なら
 * 入力配列の並び順に関係なく同じ結果になる（旧 C6 相当）。
 */
export function omakase(dataset: Dataset, opts: { seed: number }): Scored {
  const pool = survivors(dataset)
    .filter((c) => supplyRankIndex(combinedRankFor(c.id, dataset.supply)) >= supplyRankIndex('少ない'))
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (pool.length === 0) {
    throw new Error('omakase: 供給量「少ない」以上のキャラが0件（データ不整合）');
  }

  const weights = pool.map((c) => supplyRankIndex(combinedRankFor(c.id, dataset.supply)));
  const picked = weightedPick(pool, weights, mulberry32(opts.seed));
  const rank = combinedRankFor(picked.id, dataset.supply);

  return {
    character: picked,
    score: 0,
    supplyRank: rank,
    reasons: [{ kind: 'supply', rank, label: supplyLabelFor(rank) }],
  };
}
