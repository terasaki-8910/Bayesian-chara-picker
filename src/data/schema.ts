import { z } from 'zod';

/**
 * SPEC 2.3 の属性 16 軸。許容値は SPEC から書き起こす。
 * ACCEPTANCE A5 は tests/helpers/data.ts に独立した literal を持ち、
 * ここと突き合わせて typo を検出する（二重化が検出力そのもの）。
 */
const GENDER_EXPRESSION_VALUES = ['女性', 'おとこの娘', 'ふたなり', '男性'] as const;
const AGE_FEEL_VALUES = ['幼い', '同年代', '年上', '熟れた'] as const;
/** 体格のみ。胸は BUST_VALUES に分離した（旧「グラマー」は体格と胸を混同していた）。 */
const BUILD_VALUES = ['華奢', '標準', 'むっちり'] as const;
const BUST_VALUES = ['小さい', '標準', '大きい', 'とても大きい'] as const;
const PERSONALITY_VALUES = ['クール', '元気', 'おっとり', '生意気', '内気', '姉御', 'むっつり'] as const;
const ROLES_VALUES = ['幼馴染', '後輩', '先輩', '姉', '妹', '母性', '教師', '主従', 'ライバル', '恋人・伴侶', '友人'] as const;
const DISTANCE_VALUES = ['積極的', 'やや積極的', '中立', 'やや受け身', '受け身'] as const;
/** 髪色・肌色はそれぞれ独立した軸に移した（旧 looks の「白髪」「褐色」）。 */
const LOOKS_VALUES = ['眼鏡', 'ケモミミ', '角', '尻尾', '長髪', 'ツインテール', '眼帯'] as const;
const HAIR_COLOR_VALUES = ['黒', '白', '金', '茶', '赤', '青', '緑', '桃', '紫', '銀', '橙'] as const;
const SKIN_TONE_VALUES = ['色白', '標準', '褐色'] as const;
const OUTFIT_VALUES = ['制服', 'メイド', '巫女', 'ナース', '魔法少女', '軍服', 'OL', '和服・着物'] as const;
const SPECIES_VALUES = ['人間', 'エルフ', '獣人', '魔族', '機械', '不死'] as const;
const MOOD_VALUES = ['甘め', '支配的', '従属的', '純愛寄り', '背徳寄り'] as const;
const COMBAT_VALUES = ['戦う', '戦わない'] as const;
/** 「学校に通っているか」に相当する広い分岐。所属名はこれとは別に自由記述で持つ。 */
const AFFILIATION_KIND_VALUES = ['学生', '社会人', '軍・組織', '冒険者', '非人間・その他'] as const;
/**
 * 身長の印象。BUILD_VALUES（体格の太さ）とは独立した軸——「華奢だが長身」
 * 「むっちりだが小柄」のどちらも普通に存在するため、1軸に混ぜない。
 */
const STATURE_VALUES = ['小柄', '標準', '長身'] as const;
/**
 * 職業・立場。`affiliationKind`（学生/社会人/…の5値）より細かく、
 * `affiliationName`（「ミレニアムサイエンススクール（C&C）」のような固有名）より粗い
 * 中間粒度にする——固有名をそのまま質問にすると1キャラしか該当せず
 * 「絞り込む質問」ではなく「答えを知っているか確かめる質問」になってしまうため。
 * 複数値: 「巫女であり神様でもある」「アイドルでありアスリートでもある」が普通にある。
 */
const OCCUPATION_VALUES = [
  '忍者', '海賊', '兵士・軍人', '警察・公安', 'スパイ・暗殺者', 'アイドル・芸能',
  'アスリート', '巫女・神職', '神様・精霊', 'メイド・従者', '王族・貴族',
  '医療従事者', '研究者・発明家', '魔法使い・魔術師',
  '会社員・OL', '教師・講師', '格闘家・武道家',
] as const;

/**
 * 軸の値は `string`（配列軸は `string[]`）で緩く型付けする。
 * SPEC 2.3 の厳密な許容値チェックは実行時の zod スキーマ（下記）と
 * ACCEPTANCE A5 が担う。ここを literal union にすると `data/characters.json`
 * の生の値（QA 前の下書きを含む）を汎用的に読めなくなり、A4 のような
 * 「空文字/未設定を検出する」テストの型検査自体が壊れる。
 * `Reason.value` / `QuestionOption.value`（wave 3 以降）も同じ理由で `string`。
 */
export type Axes = {
  genderExpression: string | null;
  ageFeel: string | null;
  build: string | null;
  bust: string | null;
  /**
   * 性格は複数値（配列）。1値限定だと「クールだが実はむっつり」のような
   * 併存する特性を表現できず、ユーザーから明示指摘があった（例: ダクネス）。
   * roles/occupation と同じ「持つか持たないか」の集合として扱う——
   * 頼光「甘め0.7/支配的0.3」のような重み付き確率分布は意図的に採らない
   * （マージ式の新規設計が要り、既存のestimateAxisMultiLikelihood/
   * estimateLlmLikelihoodをそのまま流用できないため。ユーザー合意済み、
   * 2026-08-01）。必須8軸の1つなので空配列は許容しない（A4）。
   */
  personality: string[];
  roles: string[];
  distance: string | null;
  looks: string[];
  /** 複数値（配列）。personality/mood と同じモデル（2026-08-01。ナヒーダの
   * 白62%/緑62%のような毛先グラデーションを表現するため）。必須8軸の1つなので
   * 空配列は許容しない（A4）。 */
  hairColor: string[];
  skinTone: string | null;
  outfit: string[];
  species: string | null;
  /** 複数値（配列）。personality と同じ理由・同じモデル（2026-08-01）。必須ではないので空配列=未設定。 */
  mood: string[];
  combat: string | null;
  affiliationKind: string | null;
  /**
   * 所属名。固定 enum にしない — 「アビドス高等学校」「黒ひげ海賊団」のように
   * シリーズ固有で、全作品を網羅する enum は維持不能になる。候補が同一シリーズに
   * 収束したときだけ聞く深掘り質問（Akinator の「〜学校？」に相当）に使う。
   */
  affiliationName: string | null;
  stature: string | null;
  occupation: string[];
};

export type AxisKey = keyof Axes;

/**
 * hitomi.la のタグ検索クエリ。`character` はキャラタグ（例: "narberal gamma"）。
 * `series` は同名キャラが他作品と衝突する場合にのみ指定する series タグ
 * （例: "azur lane"）。指定時は character タグと series タグの積集合の件数を使う
 * （素の character タグ件数は他作品の同名キャラを含み得るため。SPEC 2.2）。
 */
export type HitomiQuery = {
  character: string;
  series: string | null;
};

export type Character = {
  id: string; // 一意（A3）
  name: string;
  aliases: string[];
  series: string;
  dlsiteQuery: string | null; // null = DLsite収集の対象外（SPEC 2.1）
  hitomiQuery: HitomiQuery | null; // null = hitomi.la収集の対象外（SPEC 2.2）
  axes: Axes;
  reviewed: boolean; // A2。人間のレビューでのみ true になる（SPEC 4.3）
  /**
   * true = 公式デザイン未確定などの理由でレビューを完了できないキャラ。
   * A2（reviewed:false を禁じるゲート）の対象外にする代わり、reviewed は
   * 恒久的に false のまま置く。推薦・おまかせのハードフィルタでも常に除外する
   * （性別表現「男性」と同じ扱い。SPEC 2.4 / 4.3）。
   */
  provisional: boolean;
  /**
   * ユーザー本人が合法的に所持・作成した画像への相対パス
   * （例: "/character-images/rezero-rem.webp"）。`public/character-images/`
   * に手動で置く運用。DLsite/hitomi 等の第三者画像は同梱しない方針は不変
   * （SPEC 3）— これはあくまで利用者自身の画像のための経路。null = 未設定。
   */
  imagePath: string | null;
  /**
   * true = `imagePath` の画像がこのキャラのものとして確認済み。false のまま
   * 画像を設定することもでき、その場合 UI は画像自体は表示しつつ「承認前」
   * バッジを重ねる（`reviewed` とは独立。属性データの正しさではなく
   * 「この画像がこのキャラで合っているか」だけを表す）。
   */
  imageApproved: boolean;
};

export type SupplyEntry = {
  pageCount: number;
  estimatedRange: [number, number];
  byWorkType: Record<string, number>;
  fetchedAt: string; // ISO 8601（A8 の正規表現に一致すること）
  hitomi: HitomiSupplyEntry | null; // null = hitomiQuery が null、または未収集
};

/** `HitomiQuery` の積集合計算まで終えた結果。件数の単位はギャラリー数（DLsiteのpageCountとは別単位）。 */
export type HitomiSupplyEntry = {
  galleryCount: number;
  seriesFilter: string | null; // 積集合に使った series タグ。使わなければ null（トレーサビリティ用）
  fetchedAt: string; // ISO 8601
};

export type SupplyFile = Record<string, SupplyEntry>;

/**
 * 必須 8 軸（性別表現・年齢感・体格・胸・性格・髪色・戦うか・所属の種類）は null を弾く。
 * 必須が少ないと「必須だけ埋めた薄いデータ」で 500 体を投入でき、動的質問選択
 * （SPEC 2.4）が分岐する材料を持てなくなる。追加した 4 つは主観ではなく事実寄りの
 * 軸を選んであり、規模を増やしても品質が落ちにくい。
 * 残りの軸は「空欄」を許容する: 単一軸は null、複数軸は [] が空欄
 * （SPEC 2.3 / PLAN wave 1）。空欄許容は「供給先行で大量にキャラを入れ、
 * 属性は後から埋める」拡充方針を成立させるための前提でもある。
 */
const axesSchema: z.ZodType<Axes> = z.object({
  genderExpression: z.enum(GENDER_EXPRESSION_VALUES),
  ageFeel: z.enum(AGE_FEEL_VALUES),
  build: z.enum(BUILD_VALUES),
  bust: z.enum(BUST_VALUES),
  personality: z.array(z.enum(PERSONALITY_VALUES)).min(1),
  roles: z.array(z.enum(ROLES_VALUES)),
  distance: z.enum(DISTANCE_VALUES).nullable(),
  looks: z.array(z.enum(LOOKS_VALUES)),
  hairColor: z.array(z.enum(HAIR_COLOR_VALUES)).min(1),
  skinTone: z.enum(SKIN_TONE_VALUES).nullable(),
  outfit: z.array(z.enum(OUTFIT_VALUES)),
  species: z.enum(SPECIES_VALUES).nullable(),
  mood: z.array(z.enum(MOOD_VALUES)),
  combat: z.enum(COMBAT_VALUES),
  affiliationKind: z.enum(AFFILIATION_KIND_VALUES),
  affiliationName: z.string().min(1).nullable(),
  stature: z.enum(STATURE_VALUES).nullable(),
  occupation: z.array(z.enum(OCCUPATION_VALUES)),
});

const hitomiQuerySchema: z.ZodType<HitomiQuery> = z.object({
  character: z.string().min(1),
  series: z.string().min(1).nullable(),
});

const characterSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    aliases: z.array(z.string()),
    series: z.string(),
    // null = DLsite 検索でこのキャラだけを引ける文字列を確定できず、収録対象外。
    dlsiteQuery: z.string().min(1).nullable(),
    // null = hitomi.la のタグでこのキャラを一意に特定できず、収録対象外。
    hitomiQuery: hitomiQuerySchema.nullable(),
    axes: axesSchema,
    reviewed: z.boolean(),
    provisional: z.boolean(),
    imagePath: z.string().min(1).nullable(),
    imageApproved: z.boolean(),
  })
  .refine((c) => !c.imageApproved || c.imagePath !== null, {
    message: 'imageApproved は imagePath が設定されているときのみ true にできる',
    path: ['imageApproved'],
  }) satisfies z.ZodType<Character>;

export const charactersSchema: z.ZodType<Character[]> = z.array(characterSchema);

/** A8 が要求する ISO 8601（date-time、オフセットまたは Z 必須）。 */
const ISO_8601_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const hitomiSupplyEntrySchema: z.ZodType<HitomiSupplyEntry> = z.object({
  galleryCount: z.number().int().nonnegative(),
  seriesFilter: z.string().min(1).nullable(),
  fetchedAt: z.string().regex(ISO_8601_DATE_TIME),
});

const supplyEntrySchema: z.ZodType<SupplyEntry> = z.object({
  pageCount: z.number().int().nonnegative(),
  estimatedRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  byWorkType: z.record(z.string(), z.number().int().nonnegative()),
  fetchedAt: z.string().regex(ISO_8601_DATE_TIME),
  hitomi: hitomiSupplyEntrySchema.nullable(),
});

/** キーはキャラ id（PLAN wave 1）。 */
export const supplyFileSchema: z.ZodType<SupplyFile> = z.record(z.string(), supplyEntrySchema);
