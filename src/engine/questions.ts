import type { Axes, AxisKey, Character } from '../data/schema';

/**
 * Akinator実機のラベル表記そのまま採用（5段階）。ユーザー提供のスクリーンショットに
 * 実在する文言。「こだわらない」のような独自ラベルは作らない —
 * 「わからない」が実質その役割を兼ねる（重み0。CONFIDENCE_WEIGHT参照）。
 */
export type Confidence = 'yes' | 'probably_yes' | 'unknown' | 'probably_no' | 'no';

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  yes: 'はい',
  probably_yes: 'たぶんそう',
  unknown: 'わからない',
  probably_no: 'たぶん違う',
  no: 'いいえ',
};

export const CONFIDENCE_WEIGHT: Record<Confidence, number> = {
  yes: 1,
  probably_yes: 0.5,
  unknown: 0,
  probably_no: -0.5,
  no: -1,
};

/**
 * 質問1つ = `(軸, 値)` ペア1つに対する二値プローブ（例: 「髪は黒いですか?」）。
 * 軸の全選択肢を一度に並べる旧方式（wave 3）をやめ、値ごとに独立した質問として
 * 動的に生成する。複数値軸（roles/looks/outfit）と単一値軸を同じ枠組みで扱える
 * 利点がある（PLAN「質問モデル」参照）。
 *
 * `key` はプローブの一意な識別子であり、`askedKeys` の集合演算はこれを単位にする。
 * 単一値軸と複数値軸で区切り文字を変える（`=` / `~`）: 同じ軸・同じ値でも
 * 単一/複数の区別を key だけから復元できるようにするため（デバッグ・ログ用途）。
 */
export type Probe = {
  key: string;
  axis: AxisKey;
  value: string;
  multi: boolean;
  prompt: string;
};

/** 複数値軸（`Axes` 上で `string[]` の軸）。他は単一値軸（`string | null`）。 */
const MULTI_AXES: readonly AxisKey[] = ['roles', 'looks', 'outfit'];
const MULTI_AXIS_SET = new Set<AxisKey>(MULTI_AXES);

/**
 * 軸の列挙順。`buildProbePool` の出力順・`selectProbe` のタイブレーク優先順位の
 * 両方に使う固定配列（PLAN「タイブレークは固定優先順位配列＋微小イプシロン」）。
 * 事実寄りで質問しやすい軸を先に、自由記述の深掘り質問（affiliationName）を
 * 最後に置く。
 */
const AXIS_ORDER: readonly AxisKey[] = [
  'genderExpression',
  'ageFeel',
  'build',
  'bust',
  'personality',
  'distance',
  'hairColor',
  'skinTone',
  'species',
  'mood',
  'combat',
  'affiliationKind',
  'roles',
  'looks',
  'outfit',
  'affiliationName',
];

/** 軸ごとの表示ラベル（UI・スコア根拠の表示に使う）。 */
export const AXIS_LABEL: Record<AxisKey, string> = {
  genderExpression: '性別表現',
  ageFeel: '年齢の印象',
  build: '体格',
  bust: '胸のサイズ',
  personality: '性格',
  roles: '関係性・属性',
  distance: '距離感',
  looks: '外見的特徴',
  hairColor: '髪色',
  skinTone: '肌の色',
  outfit: '服装',
  species: '種族',
  mood: '雰囲気',
  combat: '戦闘',
  affiliationKind: '所属の種類',
  affiliationName: '所属',
};

/**
 * 軸ごとのプロンプト文生成。「{label}は{value}ですか?」で全軸を機械的に埋めると
 * 「関係性・属性は幼馴染ですか?」のように不自然になる軸があるため、
 * Akinator実機の口調に近い言い回しを軸ごとに用意する。
 */
/**
 * ageFeel の「同年代」は「あなたと同年代」と読めてしまい、回答がユーザー自身の
 * 年齢に依存してぶれる（人によって答えが変わる = プローブとして機能しない）。
 * 4値とも「(暗黙の)何かを基準にした相対表現」を避け、絶対的な年齢帯の言い回しに
 * 個別に差し替える。
 */
const AGE_FEEL_PROMPTS: Record<string, string> = {
  幼い: '見た目の年齢は幼い印象ですか?',
  同年代: '見た目の年齢は10代後半〜20代前半くらいですか?',
  年上: '見た目の年齢は20代後半〜30代くらいの落ち着いた印象ですか?',
  熟れた: '見た目の年齢は大人びて熟れた印象ですか?',
};

const PROMPT_BUILDERS: Record<AxisKey, (value: string) => string> = {
  genderExpression: (v) => `性別表現は${v}に近いですか?`,
  ageFeel: (v) => AGE_FEEL_PROMPTS[v] ?? `年齢の印象は${v}に近いですか?`,
  build: (v) => `体格は${v}ですか?`,
  bust: (v) => `胸のサイズは${v}ですか?`,
  personality: (v) => `性格は${v}寄りですか?`,
  roles: (v) => `${v}に当てはまりますか?`,
  distance: (v) => `距離感は${v}ですか?`,
  looks: (v) => `${v}がありますか?`,
  hairColor: (v) => `髪は${v}系ですか?`,
  skinTone: (v) => `肌の色は${v}ですか?`,
  outfit: (v) => `${v}系の服装ですか?`,
  species: (v) => `種族は${v}ですか?`,
  mood: (v) => `雰囲気は${v}寄りですか?`,
  combat: (v) => `${v}キャラですか?`,
  affiliationKind: (v) => `所属は${v}ですか?`,
  affiliationName: (v) => `所属は${v}ですか?`,
};

function buildPrompt(axis: AxisKey, value: string): string {
  return PROMPT_BUILDERS[axis](value);
}

function probeKey(axis: AxisKey, value: string, multi: boolean): string {
  return multi ? `${axis}~${value}` : `${axis}=${value}`;
}

function axisValuesOf(axes: Axes, axis: AxisKey): readonly string[] {
  const raw = axes[axis];
  if (raw === null || raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/**
 * 与えられた集団に実在する `(軸, 値)` の組み合わせだけからプローブ集合を作る。
 * 集団に1件も存在しない値のプローブは生成しない — 「聞いても全員に無関係」な
 * 質問を候補にすら乗せないための設計（`selectProbe` の p=0 除外は自動的に
 * 満たされる。残るのは p=1 の場合のエントロピー0によるフィルタのみ）。
 *
 * 出力順は `AXIS_ORDER` → 値の辞書順で固定する。`selectProbe` のタイブレークは
 * この順序に依存する。
 */
export function buildProbePool(characters: readonly Character[]): Probe[] {
  const seen = new Map<string, Probe>();
  for (const character of characters) {
    for (const axis of AXIS_ORDER) {
      const multi = MULTI_AXIS_SET.has(axis);
      for (const value of axisValuesOf(character.axes, axis)) {
        const key = probeKey(axis, value, multi);
        if (seen.has(key)) continue;
        seen.set(key, { key, axis, value, multi, prompt: buildPrompt(axis, value) });
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) => {
    const axisDiff = AXIS_ORDER.indexOf(a.axis) - AXIS_ORDER.indexOf(b.axis);
    if (axisDiff !== 0) return axisDiff;
    return a.value.localeCompare(b.value, 'ja');
  });
}

function hasTrait(character: Character, probe: Probe): boolean {
  const raw = character.axes[probe.axis];
  if (probe.multi) return Array.isArray(raw) && raw.includes(probe.value);
  return raw === probe.value;
}

/** 二値エントロピー。p<=0 または p>=1 で 0（聞く意味がない = 全員一致 or 該当者なし）。 */
function binaryEntropy(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

function presenceRatio(population: readonly Character[], probe: Probe): number {
  if (population.length === 0) return 0;
  const count = population.filter((c) => hasTrait(c, probe)).length;
  return count / population.length;
}

/** 浮動小数の実質同点をイプシロンで吸収する（PLAN「微小イプシロン」）。 */
const ENTROPY_EPSILON = 1e-9;

/** これ未満のエントロピーは「聞く意味がない」として質問候補から外す（ビット単位）。 */
export const MIN_GAIN = 0.35;

/** 最低質問数。この数に達するまでは `shouldGuess`（recommend.ts）が推測を許さない。 */
export const MIN_QUESTIONS = 6;

/** 質問数の絶対上限。これに達したら情報量に関わらず推測へ進む。 */
export const HARD_CAP = 10;

/** ハイブリッド母集団で使う接戦集合のサイズ（スコア上位M体）。 */
export const CONTENTION_M = 10;

/**
 * 次に聞くべきプローブを、渡された集団を最もよく二分する `(軸, 値)` から選ぶ
 * （SPEC 2.4）。学習データは使わない — 既にある「キャラ×軸」の行列だけで
 * 計算する純粋なエントロピー最大化。
 *
 * `population` は呼び出し側（recommend.ts の `nextProbe`）が決める。通常は
 * 回答と矛盾しない作業集合、作業集合が2体未満に縮んだ後はスコア上位M体の
 * 接戦集合に切り替える「ハイブリッド母集団」——この関数自身は集団の由来を
 * 知らず、渡された集団の中だけでエントロピーを計算する。
 *
 * 同点（イプシロン以内）は `buildProbePool` の出力順（= 固定優先順位配列）で
 * 先に現れた方を採用する。ループ内で `>` のみを使い `>=` を使わないことで
 * この決定論を実現している。
 */
export function selectProbe(population: readonly Character[], askedKeys: ReadonlySet<string>): Probe | null {
  if (population.length === 0) return null;

  const pool = buildProbePool(population);
  let best: Probe | null = null;
  let bestGain = -Infinity;

  for (const probe of pool) {
    if (askedKeys.has(probe.key)) continue;
    const gain = binaryEntropy(presenceRatio(population, probe));
    if (gain > bestGain + ENTROPY_EPSILON) {
      best = probe;
      bestGain = gain;
    }
  }

  return best !== null && bestGain >= MIN_GAIN ? best : null;
}
