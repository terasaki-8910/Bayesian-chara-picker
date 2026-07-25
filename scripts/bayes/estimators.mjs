/**
 * ベイズ尤度推定の純粋関数群（PLAN「数理仕様」§3.1）。ネットワークI/O・ファイルI/Oを
 * 一切行わない。scripts/bayes/build-likelihoods.mjs から呼ばれ、
 * tests/bayes-pipeline.test.ts が数値例で単体テストする。
 *
 * 用語:
 *   p_data  = Danbooruタグ共起から推定した尤度 P(yes|c)
 *   p_axis  = 既存16軸データから推定した疑似尤度
 *   n_eff   = p_data の実効サンプル数（信頼度の重みとしてマージ式に使う。
 *             0なら「データが無い」と同義になり、マージ時に自動的に無視される）
 */

export const DEFAULT_EPSILON = 0.02;
/** グループ質問の平滑化定数K（少サンプルは基底率へ縮退させる強さ）。 */
export const GROUP_SMOOTHING_K = 10;
/** 二値質問のラプラス平滑化の疑似カウント。 */
export const BINARY_PRIOR_COUNT = 0.5;
/** θ_q（タグ付与率の天井）の下限。 */
export const BINARY_THETA_FLOOR = 0.05;
export const BINARY_THETA_PERCENTILE = 0.95;

export const AXIS_SINGLE_MATCH = 0.9;
export const AXIS_SINGLE_MISMATCH = 0.1;
export const AXIS_MULTI_INCLUDES = 0.9;
export const AXIS_MULTI_EXCLUDES = 0.2;

/** マージ式での16軸ソースの固定重み W_AXIS。 */
export const AXIS_MERGE_WEIGHT = 30;
/**
 * マージ式でのWikidata構造化事実ソースの固定重み W_WIKIDATA（Phase 5a）。
 * 「自前レビュー済み16軸(30) > 外部ハード事実(25) > LLM推論(15)」の序列にする——
 * Wikidataは客観的事実だが (a) 外部由来でこのプロジェクトのenum写像は未レビュー、
 * (b) 版違い（別デザイン）を指すことがある（PLAN「species版差問題」）ため、
 * 自前16軸より一段弱くする。実務上hairColor/eyeColor質問ではDanbooruのn_eff
 * （数百〜1000）が支配的なので、この定数の厳密な値自体は低リスク。
 */
export const WIKIDATA_MERGE_WEIGHT = 25;
export const WIKIDATA_LIKELY_YES = 0.9;
export const WIKIDATA_LIKELY_NO = 0.1;
/** マージ式でのLLM抽出ソースの固定重み W_LLM（Phase 5b）。16軸の半分——
 * LLMがノイズを出しても軸の確信を反転させず減衰に留める安全設計（BC13保護）。 */
export const LLM_MERGE_WEIGHT = 15;
export const LLM_LIKELY_YES = 0.85;
export const LLM_LIKELY_NO = 0.15;
/**
 * 「証拠なし」の中立アンカー値そのもの（記録用の定数）。マージには使わない——
 * estimateWikidataLikelihood/estimateLlmLikelihood は証拠なしを常にnullで返す。
 * 0.5をweight付きでマージへ混ぜると、軸側が0.9で確信していても
 * σ((30·logit(0.9)+15·logit(0.5))/(30+15)) ≈ 0.81 まで引き下げてしまい、
 * BC13のオラクル閾値(p>=0.75)に対する安全マージンを不必要に削ってしまう
 * （2026-07-25、P5設計時に判明。0.81自体は閾値を割らないが、他ソースの
 * 追加分と重なると割り込むリスクがあるため、証拠なしは一貫してnullにする）。
 */
export const LLM_NO_EVIDENCE = 0.5;

/** [epsilon, 1-epsilon] にクランプする（logitが±Infinityにならないようにする）。 */
export function clamp01(p, epsilon = DEFAULT_EPSILON) {
  return Math.min(1 - epsilon, Math.max(epsilon, p));
}

export function logit(p) {
  return Math.log(p / (1 - p));
}

export function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * グループ質問（排他的タグ集合内の1値）の尤度。少サンプルほど基底率 b_q へ縮退する
 * （K=10。n_G=0ならp=b_qそのものになる — 「データ無し」を正しく無情報化する）。
 * @param {{ k_q: number, n_G: number, b_q: number, K?: number }} params
 */
export function estimateGroupLikelihood({ k_q, n_G, b_q, K = GROUP_SMOOTHING_K }) {
  if (n_G < 0 || k_q < 0 || k_q > n_G) {
    throw new Error(`estimateGroupLikelihood: 不正な入力 (k_q=${k_q}, n_G=${n_G})`);
  }
  return (k_q + K * b_q) / (n_G + K);
}

/**
 * グループの基底率 b_q = 全キャラ合計の k_q ÷ 全キャラ合計の n_G。
 * @param {{ k_q: number, n_G: number }[]} perCharacter
 */
export function computeGroupBaseRate(perCharacter) {
  let sumK = 0;
  let sumN = 0;
  for (const { k_q, n_G } of perCharacter) {
    sumK += k_q;
    sumN += n_G;
  }
  return sumN === 0 ? 0 : sumK / sumN;
}

/**
 * 二値質問の生率（ラプラス平滑化込み）。n_c=0でも0.5に落ち着くだけで、
 * 呼び出し側がn_eff(=n_c)を0として扱う限り実害は無い（マージ時に無視される）。
 * @param {{ k_t: number, n_c: number, prior?: number }} params
 */
export function estimateBinaryRawRate({ k_t, n_c, prior = BINARY_PRIOR_COUNT }) {
  if (n_c < 0 || k_t < 0 || k_t > n_c) {
    throw new Error(`estimateBinaryRawRate: 不正な入力 (k_t=${k_t}, n_c=${n_c})`);
  }
  return (k_t + prior) / (n_c + 2 * prior);
}

/**
 * 全キャラの生率からP95を取り天井θ_qを決める（「そのタグを持つキャラでも
 * 全投稿には付かない」ことの補正。床は0.05）。
 * @param {number[]} rawRates
 */
export function computeBinaryTheta(rawRates, { floor = BINARY_THETA_FLOOR, percentile = BINARY_THETA_PERCENTILE } = {}) {
  if (rawRates.length === 0) return floor;
  const sorted = [...rawRates].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(percentile * sorted.length));
  return Math.max(floor, sorted[idx]);
}

/**
 * 二値質問の最終尤度 = clamp(生率/θ, ε, 1-ε)。
 * @param {{ k_t: number, n_c: number, theta: number, epsilon?: number, prior?: number }} params
 */
export function estimateBinaryLikelihood({ k_t, n_c, theta, epsilon = DEFAULT_EPSILON, prior = BINARY_PRIOR_COUNT }) {
  if (theta <= 0) throw new Error(`estimateBinaryLikelihood: thetaは正の値である必要があります (theta=${theta})`);
  const raw = estimateBinaryRawRate({ k_t, n_c, prior });
  return clamp01(raw / theta, epsilon);
}

/**
 * 16軸(単一値)からの疑似尤度。値が空欄(null/undefined/'')なら「寄与なし」でnullを返す
 * （マージ側で自動的に無視させるため、0.5等の当たり障りない値では返さない）。
 * @param {string | null | undefined} charValue
 * @param {string} targetValue
 * @returns {number | null}
 */
export function estimateAxisSingleLikelihood(charValue, targetValue) {
  if (charValue === null || charValue === undefined || charValue === '') return null;
  return charValue === targetValue ? AXIS_SINGLE_MATCH : AXIS_SINGLE_MISMATCH;
}

/**
 * 16軸(複数値配列)からの疑似尤度。空配列なら「寄与なし」でnull。
 * 配列だが対象値を含まない場合は「非網羅リストなので不在は弱い証拠」として0.2
 * （0.1より緩い——複数値軸はリストアップ漏れが起きやすいため）。
 * @param {string[] | null | undefined} charArray
 * @param {string} targetValue
 * @returns {number | null}
 */
export function estimateAxisMultiLikelihood(charArray, targetValue) {
  if (!Array.isArray(charArray) || charArray.length === 0) return null;
  return charArray.includes(targetValue) ? AXIS_MULTI_INCLUDES : AXIS_MULTI_EXCLUDES;
}

/**
 * Wikidata構造化事実からの疑似尤度（PLAN「P5」）。単一値は一致0.9/不一致0.1、
 * 複数値（現状はspecies=人間の確認限定用途のみ）は含む場合のみ0.9・それ以外は
 * null（不在に負信号を出さない——species版差問題対策。P31の分類がプロジェクト側の
 * 種族enumと1:1対応しないため、「人間である」という正信号だけを信頼し、
 * 「人間でない」を他の種族値への負信号として使わない）。
 * @param {{ value: string | string[] | null | undefined, target: string, multi: boolean }} params
 * @returns {number | null}
 */
export function estimateWikidataLikelihood({ value, target, multi }) {
  if (multi) {
    if (!Array.isArray(value) || value.length === 0) return null;
    return value.includes(target) ? WIKIDATA_LIKELY_YES : null;
  }
  if (value === null || value === undefined || value === '') return null;
  return value === target ? WIKIDATA_LIKELY_YES : WIKIDATA_LIKELY_NO;
}

/**
 * ローカルLLM抽出(evidence-first+引用照合ゲート通過分のみ)からの疑似尤度
 * （PLAN「P5b」）。verified!==true（引用が原文に実在しない/該当なし）または
 * confidence!=='high'（LLM自身の自己申告が低確信）なら常にnull——
 * 引用照合ゲートは「捏造引用」しか検出できず「実在文の誤ラベル」は防げないため、
 * confidenceゲートを重ねて保守的にする多層防御の一部（W_LLM=15自体も軸(30)より
 * 弱く、誤りが混入しても確信を反転できず減衰に留める設計。ゲートの限界は
 * 引用照合だけで完結させず、BC13の自己収束チェックが最終防衛線）。
 * @param {{ value?: string | null, values?: string[], target: string, multi: boolean, verified: boolean, confidence: string }} params
 * @returns {number | null}
 */
export function estimateLlmLikelihood({ value, values, target, multi, verified, confidence }) {
  if (verified !== true) return null;
  if (confidence !== 'high') return null;
  if (multi) {
    if (!Array.isArray(values) || values.length === 0) return null;
    return values.includes(target) ? LLM_LIKELY_YES : null;
  }
  if (value === null || value === undefined || value === '' || value === '該当なし') return null;
  return value === target ? LLM_LIKELY_YES : LLM_LIKELY_NO;
}

/**
 * @typedef {{ p: number | null | undefined, weight: number }} LikelihoodSource
 */

/**
 * logit空間の信頼度加重平均で複数ソースをマージする。p===null/undefined または
 * weight<=0 のソースは無視する。有効なソースが1つも無ければ fallback を返す
 * （呼び出し側はここに b_q 等その質問の意味のある既定値を渡すこと。無条件の
 * 0.5のようなマジックナンバーに頼らせないため、fallback は必須引数にしてある）。
 * @param {LikelihoodSource[]} sources
 * @param {number} fallback
 * @param {{ epsilon?: number }} [opts]
 */
export function mergeLikelihoods(sources, fallback, { epsilon = DEFAULT_EPSILON } = {}) {
  const valid = sources.filter((s) => s.p !== null && s.p !== undefined && s.weight > 0);
  if (valid.length === 0) return clamp01(fallback, epsilon);

  let num = 0;
  let den = 0;
  for (const { p, weight } of valid) {
    num += weight * logit(clamp01(p, epsilon));
    den += weight;
  }
  return clamp01(sigmoid(num / den), epsilon);
}
