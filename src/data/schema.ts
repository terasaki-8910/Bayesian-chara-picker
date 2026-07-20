import { z } from 'zod';

/**
 * SPEC 2.3 の属性 10 軸。許容値は SPEC から書き起こす。
 * ACCEPTANCE A5 は tests/helpers/data.ts に独立した literal を持ち、
 * ここと突き合わせて typo を検出する（二重化が検出力そのもの）。
 */
const GENDER_EXPRESSION_VALUES = ['女性', 'おとこの娘', 'ふたなり', '男性'] as const;
const AGE_FEEL_VALUES = ['幼い', '同年代', '年上', '熟れた'] as const;
const BUILD_VALUES = ['小柄華奢', '標準', 'グラマー', 'むちむち'] as const;
const PERSONALITY_VALUES = ['クール', '元気', 'おっとり', '生意気', '内気', '姉御'] as const;
const ROLES_VALUES = ['幼馴染', '後輩', '先輩', '姉', '妹', '母性', '教師', '主従', 'ライバル'] as const;
const DISTANCE_VALUES = ['積極的', 'やや積極的', '中立', 'やや受け身', '受け身'] as const;
const LOOKS_VALUES = ['眼鏡', 'ケモミミ', '尻尾', '褐色', '白髪', '長髪', 'ツインテール'] as const;
const OUTFIT_VALUES = ['制服', 'メイド', '巫女', 'ナース', '魔法少女', '軍服', 'OL'] as const;
const SPECIES_VALUES = ['人間', 'エルフ', '獣人', '魔族', '機械', '不死'] as const;
const MOOD_VALUES = ['甘め', '支配的', '従属的', '純愛寄り', '背徳寄り'] as const;

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
  personality: string | null;
  roles: string[];
  distance: string | null;
  looks: string[];
  outfit: string[];
  species: string | null;
  mood: string | null;
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
 * 必須 4 軸（性別表現・年齢感・体型・性格）は null を弾く。
 * 残り 6 軸は「空欄」を許容する: 単一軸は null、複数軸は [] が空欄
 * （SPEC 2.3 / PLAN wave 1）。
 */
const axesSchema: z.ZodType<Axes> = z.object({
  genderExpression: z.enum(GENDER_EXPRESSION_VALUES),
  ageFeel: z.enum(AGE_FEEL_VALUES),
  build: z.enum(BUILD_VALUES),
  personality: z.enum(PERSONALITY_VALUES),
  roles: z.array(z.enum(ROLES_VALUES)),
  distance: z.enum(DISTANCE_VALUES).nullable(),
  looks: z.array(z.enum(LOOKS_VALUES)),
  outfit: z.array(z.enum(OUTFIT_VALUES)),
  species: z.enum(SPECIES_VALUES).nullable(),
  mood: z.enum(MOOD_VALUES).nullable(),
});

const hitomiQuerySchema: z.ZodType<HitomiQuery> = z.object({
  character: z.string().min(1),
  series: z.string().min(1).nullable(),
});

const characterSchema: z.ZodType<Character> = z.object({
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
});

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
