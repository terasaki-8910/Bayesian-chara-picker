import type { AxisKey, Character, SupplyFile } from '../data/schema';
import { CONFIDENCE_WEIGHT, type Confidence } from './questions';
import { combinedRankFor, survivors, type Dataset, type Reason, type Scored } from './recommend';
import { supplyRankIndex, type SupplyRank } from './supply';

export type { Confidence } from './questions';
export type { Dataset, Reason, Scored } from './recommend';

/** プローブ key（questions.json の質問id） -> 確信度。classic の AnswerMap とキー空間が違うため別名にする。 */
export type BayesAnswerMap = Record<string, Confidence>;

export type BayesProbe = {
  key: string;
  prompt: string;
  reason: { axis: AxisKey; label: string; value: string };
};

export type LikelihoodsFile = {
  epsilon: number;
  questionIds: string[];
  baseRates: number[];
  chars: Record<string, number[]>;
};
export type QuestionsRuntimeFile = {
  version: number;
  questions: { key: string; prompt: string; reason: { axis: string; label: string; value: string } }[];
};

/*
 * likelihoods / questions.runtime は import せず、initBayesData() で外から注入する。
 *
 * 理由: このエンジンは配信方法の違う2つのアプリで共有されている。
 *   - Bayesian-chara-picker: JSONを静的importしてバンドルに同梱（実行時ネットワーク0件 = D1）
 *   - terasaki-8910.github.io (/chara-picker/): 実行時fetch（約280KBを初期JSから外すため）
 * ここで静的importすると後者で必ずバンドルに載ってしまうため、データの取得元は
 * 呼び出し側の責務にして、このファイル自体は両方で完全に同一に保つ。
 * （同一に保つことで scripts/sync-chara-picker.mjs による機械的な同期が成立する）
 *
 * initBayesData() より前にエンジン関数を呼ぶと likelihoodOf() が明示的に投げる。
 */
let likelihoods: LikelihoodsFile | null = null;
let questionIndex = new Map<string, number>();
let probeByKey = new Map<string, BayesProbe>();
/** 質問選択・エントロピー計算の対象になる全プローブ（固定順=questions.runtime.jsonの記載順）。 */
let allProbes: readonly BayesProbe[] = [];

export function initBayesData(l: LikelihoodsFile, q: QuestionsRuntimeFile): void {
  likelihoods = l;
  questionIndex = new Map(l.questionIds.map((id, i) => [id, i]));
  probeByKey = new Map<string, BayesProbe>(
    q.questions.map((qq) => [qq.key, { key: qq.key, prompt: qq.prompt, reason: qq.reason as BayesProbe['reason'] }]),
  );
  allProbes = q.questions.map((qq) => probeByKey.get(qq.key)!);
}

function likelihoodOf(characterId: string, questionKey: string): number {
  if (likelihoods === null) throw new Error('bayes.ts: initBayesData() より前に呼ばれた');
  const idx = questionIndex.get(questionKey);
  const arr = likelihoods.chars[characterId];
  if (idx === undefined || arr === undefined) {
    throw new Error(`bayes.ts: 未知のquestionKeyまたはcharacterId (question=${questionKey}, character=${characterId})`);
  }
  return arr[idx];
}

/**
 * 事前分布の重み V_c = galleryCount + 30・pageCount、π(c) ∝ log2(2+V_c)。
 * 供給量が多いキャラほど「そもそも聞かれやすい/描かれやすい」という弱い事前情報にする
 * （PLAN「事前分布」。供給0件のキャラも log2(2)=1 で完全な0にはならない）。
 */
function priorWeight(id: string, supply: SupplyFile): number {
  const entry = supply[id];
  const pageCount = entry?.pageCount ?? 0;
  const galleryCount = entry?.hitomi?.galleryCount ?? 0;
  const v = galleryCount + 30 * pageCount;
  return Math.log2(2 + v);
}

/**
 * 対数事後確率（正規化前）。w>0の回答は logP += w・ln p、w<0は logP += |w|・ln(1-p)、
 * w=0（どちらでも良い）は無更新（PLAN「更新」。|w|=0.5の「たぶん」系は尤度の
 * 0.5乗テンパリングに自然に一致する——特別扱いのコードは不要）。
 */
function computeLogPosterior(
  population: readonly Character[],
  supply: SupplyFile,
  answers: BayesAnswerMap,
): Map<string, number> {
  const entries = Object.entries(answers);
  const logP = new Map<string, number>();
  for (const c of population) {
    let lp = Math.log(priorWeight(c.id, supply));
    for (const [key, confidence] of entries) {
      const w = CONFIDENCE_WEIGHT[confidence];
      if (w === 0) continue;
      const p = likelihoodOf(c.id, key);
      lp += w > 0 ? w * Math.log(p) : -w * Math.log(1 - p);
    }
    logP.set(c.id, lp);
  }
  return logP;
}

/** 対数事後確率を実確率へ正規化する（max減算でオーバーフロー/アンダーフローを避ける）。 */
function normalizePosterior(logP: ReadonlyMap<string, number>): Map<string, number> {
  if (logP.size === 0) return new Map();
  const maxLog = Math.max(...logP.values());
  const unnormalized = new Map([...logP].map(([id, lp]) => [id, Math.exp(lp - maxLog)]));
  const total = [...unnormalized.values()].reduce((a, b) => a + b, 0);
  return new Map([...unnormalized].map(([id, e]) => [id, e / total]));
}

/** シャノンエントロピー（bit単位）。p=0の項は寄与0として無視する。 */
function entropyOf(probs: Iterable<number>): number {
  let h = 0;
  for (const p of probs) {
    if (p > 0) h -= p * Math.log2(p);
  }
  return h;
}

/**
 * 質問1問ぶんの期待エントロピー削減量。回答が yes/no のどちらに転んでも、
 * 事後分布をベイズ更新（p・尤度で重み付けして正規化）した上でのエントロピーを
 * 混合期待値として引く（PLAN「質問選択」）。
 */
function expectedGain(posterior: ReadonlyMap<string, number>, questionKey: string): number {
  const currentEntropy = entropyOf(posterior.values());
  let pYes = 0;
  const yesUnnorm = new Map<string, number>();
  const noUnnorm = new Map<string, number>();
  for (const [id, p] of posterior) {
    const likelihood = likelihoodOf(id, questionKey);
    const yesMass = p * likelihood;
    yesUnnorm.set(id, yesMass);
    noUnnorm.set(id, p - yesMass);
    pYes += yesMass;
  }
  const pNo = 1 - pYes;
  const hYes = pYes > 0 ? entropyOf([...yesUnnorm.values()].map((v) => v / pYes)) : 0;
  const hNo = pNo > 0 ? entropyOf([...noUnnorm.values()].map((v) => v / pNo)) : 0;
  return currentEntropy - (pYes * hYes + pNo * hNo);
}

/** 浮動小数の実質同点をイプシロンで吸収する（questions.ts の同名定数と同じ役割）。 */
const GAIN_EPSILON = 1e-9;

/** これ未満の期待エントロピー削減は「聞く意味がない」として除外する（P3スイープで確定）。 */
export const MIN_GAIN_BAYES = 0.02;

/** `rng` 指定時、僅差の上位候補（期待エントロピー削減量降順）から乱択する範囲。 */
export const TOP_K_BAYES = 5;

/**
 * 次に聞くべきベイズ質問を選ぶ。classic の `nextProbe` と違い、作業集合を
 * ハードに絞り込む処理（CONTENTION_M 相当）は無い——全 survivors への事後確率の
 * 重み付けだけで済むベイズ推定はハード制約による「集団が2体未満に縮む」問題が
 * 起きないため（PLAN「質問選択」に CONTENTION_M 相当の記載が無いのはこのため）。
 */
export function bayesNextProbe(
  dataset: Dataset,
  answers: BayesAnswerMap,
  askedKeys: ReadonlySet<string>,
  opts?: { exclude?: ReadonlySet<string>; rng?: () => number },
): BayesProbe | null {
  const population = survivors(dataset, opts?.exclude);
  if (population.length === 0) return null;

  const posterior = normalizePosterior(computeLogPosterior(population, dataset.supply, answers));
  const candidates: { probe: BayesProbe; gain: number }[] = [];
  for (const probe of allProbes) {
    if (askedKeys.has(probe.key)) continue;
    const gain = expectedGain(posterior, probe.key);
    if (gain >= MIN_GAIN_BAYES) candidates.push({ probe, gain });
  }
  if (candidates.length === 0) return null;

  if (opts?.rng === undefined) {
    let best = candidates[0];
    for (const c of candidates) {
      if (c.gain > best.gain + GAIN_EPSILON) best = c;
    }
    return best.probe;
  }

  const ranked = candidates.slice().sort((a, b) => b.gain - a.gain);
  const top = ranked.slice(0, TOP_K_BAYES);
  const idx = Math.min(Math.floor(opts.rng() * top.length), top.length - 1);
  return top[idx].probe;
}

/** score = SCORE_SCALE・P(c)。確率差0.2がMARGIN_STOP(40, recommend.ts)に対応する換算（PLAN）。 */
export const SCORE_SCALE = 200;

const EVIDENCE_WEIGHT_MIN = 0.5;
const EVIDENCE_STRONG_YES = 0.8;
const EVIDENCE_STRONG_NO = 0.2;
const EVIDENCE_COUNT = 4;

function logit(p: number): number {
  return Math.log(p / (1 - p));
}

/**
 * 根拠抽出。|w|≥0.5で答えた質問のうち、方向が強く一致するもの
 * （yes方向ならp≥0.8、no方向ならp≤0.2）だけを |w・logit(p)| 降順で最大4件。
 * 「該当しない」ことしか分からない弱い一致は根拠に出さない（classicのC5相当の設計）。
 */
function evidenceReasonsFor(characterId: string, answers: BayesAnswerMap, rank: SupplyRank): Reason[] {
  const scored: { reason: Reason; strength: number }[] = [];
  for (const [key, confidence] of Object.entries(answers)) {
    const w = CONFIDENCE_WEIGHT[confidence];
    if (Math.abs(w) < EVIDENCE_WEIGHT_MIN) continue;
    const probe = probeByKey.get(key);
    if (!probe) continue;
    const p = likelihoodOf(characterId, key);
    const stronglyYes = w > 0 && p >= EVIDENCE_STRONG_YES;
    const stronglyNo = w < 0 && p <= EVIDENCE_STRONG_NO;
    if (!stronglyYes && !stronglyNo) continue;
    scored.push({
      reason: { kind: 'trait', axis: probe.reason.axis, value: probe.reason.value, label: probe.reason.label, confidence },
      strength: Math.abs(w * logit(p)),
    });
  }
  scored.sort((a, b) => b.strength - a.strength);
  const reasons = scored.slice(0, EVIDENCE_COUNT).map((s) => s.reason);
  reasons.push({ kind: 'supply', rank, label: `供給量: ${rank}` });
  return reasons;
}

/**
 * 全 survivors を事後確率でスコアリングする。classic の `scoreCharacters` と
 * 同じ並び順契約（score DESC → supplyRank DESC → id ASC）を守る——
 * `pickGuessWithCooldown`/`topGuess`（cooldown.ts/recommend.ts）を無改造流用するため。
 */
export function bayesScoreCharacters(
  answers: BayesAnswerMap,
  dataset: Dataset,
  opts?: { exclude?: ReadonlySet<string> },
): Scored[] {
  const population = survivors(dataset, opts?.exclude);
  if (population.length === 0) return [];

  const posterior = normalizePosterior(computeLogPosterior(population, dataset.supply, answers));
  const results: Scored[] = population.map((character) => {
    const p = posterior.get(character.id) ?? 0;
    const rank = combinedRankFor(character.id, dataset.supply);
    return {
      character,
      score: SCORE_SCALE * p,
      supplyRank: rank,
      reasons: evidenceReasonsFor(character.id, answers, rank),
    };
  });

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const rankDiff = supplyRankIndex(b.supplyRank) - supplyRankIndex(a.supplyRank);
    if (rankDiff !== 0) return rankDiff;
    return a.character.id < b.character.id ? -1 : a.character.id > b.character.id ? 1 : 0;
  });

  return results;
}

/** 最低質問数。classicのMIN_QUESTIONSと同値だがベイズ側で独立にチューニングできるよう別名にする。 */
export const MIN_QUESTIONS_BAYES = 6;
/** 質問数の絶対上限（PLAN: classicの10とは別に12）。 */
export const HARD_CAP_BAYES = 12;
/** 1位の事後確率がこれ以上なら停止候補にする。 */
export const P_STOP = 0.55;
/** 1位/2位の事後確率比がこれ以上なら停止候補にする。 */
export const ODDS_STOP = 3;

/**
 * 推測を提示してよいかどうか（PLAN「停止」）。classicの`shouldGuess`とシグネチャを
 * 揃えて`useBayesInterview`からの置き換えを容易にする——ただし判定式自体は
 * スコア差(MARGIN_STOP)ではなく事後確率の絶対値・比(P_STOP/ODDS_STOP)を使う点が異なる。
 */
export function bayesShouldGuess(scored: readonly Scored[], askedCount: number, hasInformativeProbe: boolean): boolean {
  if (askedCount < MIN_QUESTIONS_BAYES) return false;
  if (askedCount >= HARD_CAP_BAYES) return true;
  if (scored.length < 2) return true;
  if (!hasInformativeProbe) return true;
  const p1 = scored[0].score / SCORE_SCALE;
  const p2 = scored[1].score / SCORE_SCALE;
  return p1 >= P_STOP && p1 / p2 >= ODDS_STOP;
}
