import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = new URL('../../', import.meta.url);

/**
 * リポジトリ相対パスの JSON を読む。
 * 未作成のときは「何を作るべきか」が分かる形で落とす（stage 1 では赤で正しい）。
 */
export function readJson<T>(relPath: string): T {
  const path = fileURLToPath(new URL(relPath, repoRoot));
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (_err) {
    throw new Error(`${relPath} が存在しません。データ層の実装が必要です。`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (_err) {
    throw new Error(`${relPath} が JSON として壊れています。`);
  }
}

/** テキストとして読む（フィクスチャ用）。 */
export function readText(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(relPath, repoRoot)), 'utf8');
}

/**
 * SPEC 2.3 の属性 16 軸。ACCEPTANCE A5 の判定基準そのものなので、
 * src 側のスキーマからは import せず、ここに literal で固定する。
 * src のスキーマに typo があれば A5 が食い違いとして検出する（二重化が目的）。
 *
 * `affiliationName` は自由記述なので許容値リストを持たない（A5 の対象外）。
 */
export const AXIS_VALUES = {
  genderExpression: ['女性', 'おとこの娘', 'ふたなり', '男性'],
  ageFeel: ['幼い', '同年代', '年上', '熟れた'],
  build: ['華奢', '標準', 'むっちり'],
  bust: ['小さい', '標準', '大きい', 'とても大きい'],
  personality: ['クール', '元気', 'おっとり', '生意気', '内気', '姉御'],
  roles: ['幼馴染', '後輩', '先輩', '姉', '妹', '母性', '教師', '主従', 'ライバル'],
  distance: ['積極的', 'やや積極的', '中立', 'やや受け身', '受け身'],
  looks: ['眼鏡', 'ケモミミ', '尻尾', '長髪', 'ツインテール'],
  hairColor: ['黒', '白', '金', '茶', '赤', '青', '緑', '桃', '紫', '銀'],
  skinTone: ['色白', '標準', '褐色'],
  outfit: ['制服', 'メイド', '巫女', 'ナース', '魔法少女', '軍服', 'OL'],
  species: ['人間', 'エルフ', '獣人', '魔族', '機械', '不死'],
  mood: ['甘め', '支配的', '従属的', '純愛寄り', '背徳寄り'],
  combat: ['戦う', '戦わない'],
  affiliationKind: ['学生', '社会人', '軍・組織', '冒険者', '非人間・その他'],
} as const;

/** SPEC 2.3: 必須は上位 4 軸。残りは空欄を許容する（供給先行の拡充方針の前提）。 */
export const REQUIRED_AXES = ['genderExpression', 'ageFeel', 'build', 'personality'] as const;

/** 複数選択の軸（値は配列）。 */
export const MULTI_AXES = ['roles', 'looks', 'outfit'] as const;

export type AxisKey = keyof typeof AXIS_VALUES;
