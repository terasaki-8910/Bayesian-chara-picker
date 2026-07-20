import type { AxisKey } from '../data/schema';

export type QuestionOption = { value: string; label: string };

export type Question = {
  /** === axis に統一する。id/axis を別々に管理すると呼び出し側の Map が必要になり、
   * 「同じ軸を2回聞かない」という不変条件を2箇所で守る羽目になる（PLAN wave 3）。 */
  id: string;
  axis: AxisKey;
  label: string;
  prompt: string;
  options: readonly QuestionOption[];
};

function options(values: readonly string[]): readonly QuestionOption[] {
  return values.map((value) => ({ value, label: value }));
}

/**
 * 質問プール。単一値の「聞ける」軸だけを対象にする。
 *
 * 複数値軸（roles/looks/outfit）は含めない — 1 キャラが複数バケットに同時所属
 * すると、動的選択の決定論的な二分探索（エントロピー計算・タイブレーク）が濁る。
 * `affiliationName` も固定プールには入れない（自由記述かつシリーズ収束後にしか
 * 意味を持たない深掘り質問なので `buildAffiliationNameQuestion` で動的に作る）。
 *
 * `genderExpression` の選択肢から「男性」は外す。ハードフィルタで生き残れない
 * 値を聞いても、その回答を選んだ瞬間に候補が全滅するだけで意味がない
 * （SPEC 2.4 のハードフィルタ）。
 */
export const QUESTION_POOL: readonly Question[] = [
  {
    id: 'genderExpression',
    axis: 'genderExpression',
    label: '性別表現',
    prompt: '性別表現はどれが近い?',
    options: options(['女性', 'おとこの娘', 'ふたなり']),
  },
  {
    id: 'ageFeel',
    axis: 'ageFeel',
    label: '年齢感',
    prompt: '年齢感はどれが近い?',
    options: options(['幼い', '同年代', '年上', '熟れた']),
  },
  {
    id: 'build',
    axis: 'build',
    label: '体格',
    prompt: '体格はどれが近い?',
    options: options(['華奢', '標準', 'むっちり']),
  },
  {
    id: 'bust',
    axis: 'bust',
    label: '胸',
    prompt: '胸はどれが近い?',
    options: options(['小さい', '標準', '大きい', 'とても大きい']),
  },
  {
    id: 'personality',
    axis: 'personality',
    label: '性格',
    prompt: '性格はどれが近い?',
    options: options(['クール', '元気', 'おっとり', '生意気', '内気', '姉御']),
  },
  {
    id: 'distance',
    axis: 'distance',
    label: '距離感',
    prompt: '距離感はどれが近い?',
    options: options(['積極的', 'やや積極的', '中立', 'やや受け身', '受け身']),
  },
  {
    id: 'hairColor',
    axis: 'hairColor',
    label: '髪色',
    prompt: '髪色はどれが近い?',
    options: options(['黒', '白', '金', '茶', '赤', '青', '緑', '桃', '紫', '銀']),
  },
  {
    id: 'skinTone',
    axis: 'skinTone',
    label: '肌色',
    prompt: '肌色はどれが近い?',
    options: options(['色白', '標準', '褐色']),
  },
  {
    id: 'species',
    axis: 'species',
    label: '種族',
    prompt: '種族はどれが近い?',
    options: options(['人間', 'エルフ', '獣人', '魔族', '機械', '不死']),
  },
  {
    id: 'mood',
    axis: 'mood',
    label: '雰囲気',
    prompt: '雰囲気はどれが近い?',
    options: options(['甘め', '支配的', '従属的', '純愛寄り', '背徳寄り']),
  },
  {
    id: 'combat',
    axis: 'combat',
    label: '戦うか',
    prompt: '戦うキャラ?',
    options: options(['戦う', '戦わない']),
  },
  {
    id: 'affiliationKind',
    axis: 'affiliationKind',
    label: '所属の種類',
    prompt: '所属はどれが近い?',
    options: options(['学生', '社会人', '軍・組織', '冒険者', '非人間・その他']),
  },
];

/**
 * 「所属名」の深掘り質問を動的に組み立てる。候補が同一シリーズに収束し、
 * 所属名の種類が少数に絞れたときだけ呼ばれる（recommend.ts の
 * AFFILIATION_NAME_MAX_DISTINCT 参照）。Dataset を知らない純関数にして
 * questions.ts を schema.ts の型のみに依存させたままにする。
 */
export function buildAffiliationNameQuestion(values: readonly string[]): Question {
  return {
    id: 'affiliationName',
    axis: 'affiliationName',
    label: '所属名',
    prompt: '所属はどれ?',
    options: options(values),
  };
}

/** 1 セッションで聞く質問数の上限。 */
export const MAX_QUESTIONS = 8;

/** 作業集合がこの人数以下まで絞れたら、上限に達する前に質問を打ち切ってよい。 */
export const STOP_CANDIDATES = 3;

/**
 * affiliationName を質問プールに加える条件: 作業集合内の非 null な所属名の
 * 種類数がこの値以下であること。未収束の状態で聞くと、シリーズをまたいだ
 * 数十件の所属名が選択肢に並んでしまう。
 */
export const AFFILIATION_NAME_MAX_DISTINCT = 4;
