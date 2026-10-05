import { describe, expect, it } from 'vitest';

import { summarizePosts } from '../scripts/bayes/export-danbooru-stats.mjs';
import type { Character } from '../src/data/schema';
import { readJson } from './helpers/data';

/**
 * BF. キャラデータの品質ゲート（軸どうしの矛盾 + Danbooru の実測との食い違い）。
 *
 * 2026-10-05 の下調べで、characters.json の査読値に次の食い違いが見つかった。
 *   - Danbooru の実測と合わない（髪色・胸・肌・looks の付け漏れ）
 *   - 軸どうしが矛盾する（メイド服だけで職業が無い、獣人なのにケモミミも尻尾も無い、等）
 * 人の目だけで 500 体を見続けるのは続かないので、機械で見張る。
 *
 * ラチェット方式（ACCEPTANCE A10 と同じ考え方）:
 *   data/bayes/quality-allowlist.json に「ルール × キャラ」の許可を理由つきで持つ。
 *   今の違反は一度だけ「2026-10-05 時点の既存の違反、見直し中」として入れてある。
 *   - 許可リストに無い違反が増えたら落ちる（新しい違反だけを止める）
 *   - 直した違反が許可リストに残っていても落ちる（消し忘れると、後で再発しても通ってしまう）
 *   - 理由の無い許可は落ちる
 *   正当な例外（作品の設定上そうなっている等）は、その理由を書いて許可リストに足す。
 *
 * Danbooru の実測は state/（gitignore）を直接読まず、data/bayes/danbooru-stats.json
 * （scripts/bayes/export-danbooru-stats.mjs が書き出した、タグの出現数だけのファイル）を読む。
 * どの PC で走らせても同じ結果になる。
 *
 * このゲートに入れなかったもの（理由）は、ルール定義の下の「入れなかったルール」に書く。
 */

// ---------------------------------------------------------------------------
// データ
// ---------------------------------------------------------------------------

type Axes = Character['axes'];

type StatsEntry = {
  tag: string;
  fetchedAt: string;
  soloPosts: number;
  hairPosts: number;
  bustPosts: number;
  counts: Record<string, number>;
};

type StatsFile = {
  version: number;
  groups: { hairColor: string[]; bust: string[] };
  singleTags: string[];
  entries: Record<string, StatsEntry>;
};

type AllowlistFile = {
  version: number;
  rules: Record<string, Record<string, string>>;
};

type QuestionsFile = { groups: Record<string, { coverageTags: string[] }> };
type TagMapFile = { entries: Record<string, { tag: string | null }> };

const characters = readJson<Character[]>('data/characters.json');
const stats = readJson<StatsFile>('data/bayes/danbooru-stats.json');
const allowlist = readJson<AllowlistFile>('data/bayes/quality-allowlist.json');
const questions = readJson<QuestionsFile>('data/bayes/questions.json');
const tagMap = readJson<TagMapFile>('data/bayes/tag-map.json');

// ---------------------------------------------------------------------------
// しきい値と、Danbooru のタグ → 軸の値の対応表
//
// 数値は「これを超えたら食い違い」と言える強さに置いている。弱く置くと、タグ付けの揺れや
// 作品の事情による誤検出が増え、許可リストが理由の薄い例外で膨らむ。
// ---------------------------------------------------------------------------

/** solo 投稿がこれ未満のキャラは Danbooru の割合で判定しない（母数が小さく、割合がぶれる）。 */
const MIN_SOLO_POSTS = 50;
/** 髪色・胸サイズのタグが付いた投稿がこれ未満のキャラは、そのグループで判定しない。 */
const MIN_GROUP_POSTS = 30;

/**
 * 髪色: 実測で 9 割以上を占める色が、査読値のどの色とも一致しなければ食い違い。
 * 査読値の色は、実測での割合が 5% 以下であることを条件に加える。複数色(白|緑 のような
 * 毛先違い)の査読値で、片方の色が実測でそれなりにあるキャラを誤検出しないため。
 * 分母は「髪色タグが付いた solo 投稿」（髪色を書かない投稿も多いので、全投稿だと割合が低く出る）。
 */
const HAIR_TOP_SHARE_MIN = 0.9;
const HAIR_REVIEWED_SHARE_MAX = 0.05;

/** パイプラインの髪色グループ(questions.json の hair-color)のタグ → 軸の値。 */
const HAIR_TAG_TO_VALUE: Record<string, string> = {
  black_hair: '黒',
  white_hair: '白',
  blonde_hair: '金',
  brown_hair: '茶',
  red_hair: '赤',
  blue_hair: '青',
  green_hair: '緑',
  pink_hair: '桃',
  purple_hair: '紫',
  grey_hair: '銀',
  orange_hair: '橙',
};

/**
 * 色名の境界があいまいな組。Danbooru では絵師によって付けるタグが割れる（暗い紫が黒に、
 * 薄い青が銀に見える、等）ので、査読値と実測最多がこの組なら語彙のずれとみなして判定しない。
 * 組は順不同。
 */
const HAIR_NEAR_PAIRS: [string, string, string][] = [
  ['白', '銀', '白髪と銀髪は white_hair と grey_hair のどちらで付けるかが割れる'],
  ['白', '金', 'プラチナブロンドは white_hair と blonde_hair に割れる'],
  ['白', '青', '薄い水色は white_hair と blue_hair に割れる'],
  ['銀', '青', '灰青は grey_hair と blue_hair に割れる'],
  ['紫', '青', '青紫は purple_hair と blue_hair に割れる'],
  ['紫', '桃', '赤紫は purple_hair と pink_hair に割れる'],
  ['紫', '黒', '暗い紫は purple_hair と black_hair に割れる'],
  ['茶', '黒', '焦げ茶は brown_hair と black_hair に割れる'],
  ['茶', '金', '明るい茶は brown_hair と blonde_hair に割れる'],
  ['茶', '橙', '赤茶は brown_hair と orange_hair に割れる'],
  ['赤', '橙', '赤橙は red_hair と orange_hair に割れる'],
  ['金', '橙', '黄橙は blonde_hair と orange_hair に割れる'],
  ['赤', '桃', '赤桃は red_hair と pink_hair に割れる'],
];
const HAIR_NEAR = new Set(HAIR_NEAR_PAIRS.flatMap(([a, b]) => [`${a}/${b}`, `${b}/${a}`]));

/**
 * 胸: 実測の多数派(6 割以上)と査読値が、4 段階の順序で 2 段以上離れていれば食い違い。
 * 1 段のずれは主観の幅（絵師・作品ごとの描き分け）の内側として見ない。
 * 分母は「胸サイズのタグが付いた solo 投稿」。
 */
const BUST_MAJORITY_SHARE_MIN = 0.6;
const BUST_GAP_MIN = 2;
const BUST_ORDER = ['小さい', '標準', '大きい', 'とても大きい'];

/**
 * 軸 bust は 4 段階なので、Danbooru の 6 段階のうち両端は内側に寄せる
 * （flat_chest は 小さい、gigantic_breasts は とても大きい。パイプラインの尤度側にも
 * 軸の値を持たないタグだが、実測の方向としてはそれぞれ最も近い段階）。
 */
const BUST_TAG_TO_VALUE: Record<string, string> = {
  flat_chest: '小さい',
  small_breasts: '小さい',
  medium_breasts: '標準',
  large_breasts: '大きい',
  huge_breasts: 'とても大きい',
  gigantic_breasts: 'とても大きい',
};

/**
 * 肌: skinTone=褐色 なのに solo 投稿の 1 割未満しか褐色系のタグが無ければ食い違い。
 * 褐色系は dark_skin と tan（日焼け）の合計で見る（合計は和集合以上になるので、
 * 「合計でも 1 割未満」なら実際に 1 割未満と言える＝誤検出に倒れない側）。
 * 逆に、褐色でないと査読したキャラの solo 投稿の 5 割以上に dark_skin が付いていれば食い違い。
 * 査読値が空欄(null)のキャラは「褐色でない」と言っていないので対象外。
 */
const SKIN_DARK_MISSING_MAX = 0.1;
const SKIN_DARK_UNLISTED_MIN = 0.5;

/**
 * looks の付け漏れ: solo 投稿の 6 割以上にそのタグが付いているのに、査読値の looks に無ければ食い違い。
 * 「多いのに無い」方向だけを見る（逆の「あるのに少ない」は、作品によって衣装違いの絵が
 * 多いなど正当な理由がありうるので入れない）。
 */
const LOOKS_MISSING_MIN = 0.6;
const LOOKS_TAGS: { ruleId: string; value: string; tag: string }[] = [
  { ruleId: 'danbooru-looks-animal-ears-missing', value: 'ケモミミ', tag: 'animal_ears' },
  { ruleId: 'danbooru-looks-tail-missing', value: '尻尾', tag: 'tail' },
  { ruleId: 'danbooru-looks-long-hair-missing', value: '長髪', tag: 'long_hair' },
];

/** 戦闘を職業とする occupation。combat=戦わない と同時には成り立たない。 */
const COMBAT_OCCUPATIONS = ['忍者', '海賊', '兵士・軍人', '警察・公安', 'スパイ・暗殺者', '格闘家・武道家'];

// ---------------------------------------------------------------------------
// ルール
// ---------------------------------------------------------------------------

type Ctx = { c: Character; stats: StatsEntry | null };

type Rule = {
  id: string;
  kind: '内部矛盾' | 'Danbooru';
  /** 何を違反とするか（失敗メッセージとレポートに出る）。 */
  describe: string;
  violates: (ctx: Ctx) => boolean;
  /** 検出力の確認用。中立なベースにこれを当てると違反になること（BF4）。 */
  fixture: (base: Ctx) => Ctx;
};

const has = (arr: readonly string[] | null | undefined, v: string): boolean => (arr ?? []).includes(v);

const withAxes = (base: Ctx, patch: Partial<Axes>): Ctx => ({ ...base, c: { ...base.c, axes: { ...base.c.axes, ...patch } } });
const withStats = (base: Ctx, patch: Partial<StatsEntry>): Ctx => {
  if (!base.stats) throw new Error('fixture: stats が無い');
  return { ...base, stats: { ...base.stats, ...patch, counts: { ...base.stats.counts, ...(patch.counts ?? {}) } } };
};

/** Danbooru のルールが判定できるキャラか（統計があり、solo 投稿が十分ある）。 */
function evaluable(s: StatsEntry | null): s is StatsEntry {
  return s !== null && s.soloPosts >= MIN_SOLO_POSTS;
}

const rateOf = (s: StatsEntry, tag: string): number => (s.counts[tag] ?? 0) / s.soloPosts;

/** グループ内の「軸の値ごとの割合」。分母はそのグループのタグが付いた投稿数。 */
function groupShares(s: StatsEntry, tagToValue: Record<string, string>, groupPosts: number): Map<string, number> {
  const shares = new Map<string, number>();
  for (const [tag, value] of Object.entries(tagToValue)) {
    shares.set(value, (shares.get(value) ?? 0) + (s.counts[tag] ?? 0) / groupPosts);
  }
  return shares;
}

/** outfit と occupation の組が「片方だけ」になっている。 */
function outfitOccupationRule(outfit: string, occupation: string): Rule {
  return {
    id: `outfit-${outfit}-occupation-mismatch`,
    kind: '内部矛盾',
    describe: `outfit=${outfit} と occupation=${occupation} の片方だけが付いている`,
    violates: ({ c }) => has(c.axes.outfit, outfit) !== has(c.axes.occupation, occupation),
    fixture: (b) => withAxes(b, { outfit: [outfit], occupation: [] }),
  };
}

const RULES: Rule[] = [
  // --- 内部矛盾 ---
  {
    id: 'human-with-beast-looks',
    kind: '内部矛盾',
    describe: 'species=人間 なのに looks にケモミミ・尻尾・角のいずれかがある',
    violates: ({ c }) => c.axes.species === '人間' && ['ケモミミ', '尻尾', '角'].some((v) => has(c.axes.looks, v)),
    fixture: (b) => withAxes(b, { species: '人間', looks: ['ケモミミ'] }),
  },
  {
    id: 'beastkin-without-ears-or-tail',
    kind: '内部矛盾',
    describe: 'species=獣人 なのに looks にケモミミも尻尾も無い',
    violates: ({ c }) => c.axes.species === '獣人' && !has(c.axes.looks, 'ケモミミ') && !has(c.axes.looks, '尻尾'),
    fixture: (b) => withAxes(b, { species: '獣人', looks: [] }),
  },
  {
    id: 'maternal-but-childlike',
    kind: '内部矛盾',
    describe: 'roles=母性 なのに ageFeel=幼い',
    violates: ({ c }) => has(c.axes.roles, '母性') && c.axes.ageFeel === '幼い',
    fixture: (b) => withAxes(b, { roles: ['母性'], ageFeel: '幼い' }),
  },
  {
    id: 'student-but-mature',
    kind: '内部矛盾',
    describe: 'affiliationKind=学生 なのに ageFeel=熟れた',
    violates: ({ c }) => c.axes.affiliationKind === '学生' && c.axes.ageFeel === '熟れた',
    fixture: (b) => withAxes(b, { affiliationKind: '学生', ageFeel: '熟れた' }),
  },
  {
    id: 'childlike-but-tall',
    kind: '内部矛盾',
    describe: 'ageFeel=幼い なのに stature=長身',
    violates: ({ c }) => c.axes.ageFeel === '幼い' && c.axes.stature === '長身',
    fixture: (b) => withAxes(b, { ageFeel: '幼い', stature: '長身' }),
  },
  {
    id: 'student-with-office-job',
    kind: '内部矛盾',
    describe: 'affiliationKind=学生 なのに occupation=会社員・OL',
    violates: ({ c }) => c.axes.affiliationKind === '学生' && has(c.axes.occupation, '会社員・OL'),
    fixture: (b) => withAxes(b, { affiliationKind: '学生', occupation: ['会社員・OL'] }),
  },
  {
    id: 'deity-or-spirit-but-human',
    kind: '内部矛盾',
    describe: 'occupation=神様・精霊 なのに species=人間',
    violates: ({ c }) => has(c.axes.occupation, '神様・精霊') && c.axes.species === '人間',
    fixture: (b) => withAxes(b, { occupation: ['神様・精霊'], species: '人間' }),
  },
  {
    id: 'nonfighter-with-combat-job',
    kind: '内部矛盾',
    describe: `combat=戦わない なのに occupation が戦闘職(${COMBAT_OCCUPATIONS.join('・')})`,
    violates: ({ c }) => c.axes.combat === '戦わない' && c.axes.occupation.some((o) => COMBAT_OCCUPATIONS.includes(o)),
    fixture: (b) => withAxes(b, { combat: '戦わない', occupation: ['忍者'] }),
  },
  {
    id: 'otokonoko-with-large-bust',
    kind: '内部矛盾',
    describe: 'genderExpression=おとこの娘 なのに bust が 大きい 以上',
    violates: ({ c }) => c.axes.genderExpression === 'おとこの娘' && ['大きい', 'とても大きい'].includes(c.axes.bust ?? ''),
    fixture: (b) => withAxes(b, { genderExpression: 'おとこの娘', bust: '大きい' }),
  },
  outfitOccupationRule('メイド', 'メイド・従者'),
  outfitOccupationRule('巫女', '巫女・神職'),
  outfitOccupationRule('ナース', '医療従事者'),
  outfitOccupationRule('OL', '会社員・OL'),
  {
    id: 'occupation-teacher-roles-mismatch',
    kind: '内部矛盾',
    describe: 'occupation=教師・講師 と roles=教師 の片方だけが付いている',
    violates: ({ c }) => has(c.axes.occupation, '教師・講師') !== has(c.axes.roles, '教師'),
    fixture: (b) => withAxes(b, { occupation: ['教師・講師'], roles: [] }),
  },

  // --- Danbooru の実測との食い違い ---
  {
    id: 'danbooru-hair-color',
    kind: 'Danbooru',
    describe:
      `実測(髪色タグが付いた solo 投稿)の ${HAIR_TOP_SHARE_MIN * 100}% 以上を占める色が、査読値のどの色とも違う` +
      `（査読値の色は実測で ${HAIR_REVIEWED_SHARE_MAX * 100}% 以下。境界色の組は除く）`,
    violates: ({ c, stats: s }) => {
      if (!evaluable(s) || s.hairPosts < MIN_GROUP_POSTS) return false;
      const shares = groupShares(s, HAIR_TAG_TO_VALUE, s.hairPosts);
      const [topValue, topShare] = [...shares.entries()].sort((a, b) => b[1] - a[1])[0];
      if (topShare < HAIR_TOP_SHARE_MIN) return false;
      const reviewed = c.axes.hairColor;
      if (reviewed.some((v) => (shares.get(v) ?? 0) > HAIR_REVIEWED_SHARE_MAX)) return false;
      if (reviewed.some((v) => HAIR_NEAR.has(`${v}/${topValue}`))) return false;
      return true;
    },
    // ベース(黒 170/180)を、赤 175/180 に差し替える。
    fixture: (b) => withStats(withAxes(b, { hairColor: ['黒'] }), { counts: { black_hair: 3, red_hair: 175 } }),
  },
  {
    id: 'danbooru-bust-gap',
    kind: 'Danbooru',
    describe:
      `実測(胸サイズのタグが付いた solo 投稿)の ${BUST_MAJORITY_SHARE_MIN * 100}% 以上を占める段階と、` +
      `査読値の bust が ${BUST_GAP_MIN} 段以上離れている`,
    violates: ({ c, stats: s }) => {
      if (!evaluable(s) || s.bustPosts < MIN_GROUP_POSTS || c.axes.bust === null) return false;
      const shares = groupShares(s, BUST_TAG_TO_VALUE, s.bustPosts);
      const [topValue, topShare] = [...shares.entries()].sort((a, b) => b[1] - a[1])[0];
      if (topShare < BUST_MAJORITY_SHARE_MIN) return false;
      return Math.abs(BUST_ORDER.indexOf(topValue) - BUST_ORDER.indexOf(c.axes.bust)) >= BUST_GAP_MIN;
    },
    fixture: (b) => withStats(withAxes(b, { bust: '小さい' }), { counts: { medium_breasts: 5, large_breasts: 140 } }),
  },
  {
    id: 'danbooru-skin-dark-missing',
    kind: 'Danbooru',
    describe: `skinTone=褐色 なのに、dark_skin と tan を合わせても solo 投稿の ${SKIN_DARK_MISSING_MAX * 100}% 未満`,
    violates: ({ c, stats: s }) => {
      if (!evaluable(s) || c.axes.skinTone !== '褐色') return false;
      return rateOf(s, 'dark_skin') + rateOf(s, 'tan') < SKIN_DARK_MISSING_MAX;
    },
    fixture: (b) => withAxes(b, { skinTone: '褐色' }),
  },
  {
    id: 'danbooru-skin-dark-unlisted',
    kind: 'Danbooru',
    describe: `skinTone が 褐色 でない(色白/標準)のに、dark_skin が solo 投稿の ${SKIN_DARK_UNLISTED_MIN * 100}% 以上`,
    violates: ({ c, stats: s }) => {
      if (!evaluable(s) || c.axes.skinTone === null || c.axes.skinTone === '褐色') return false;
      return rateOf(s, 'dark_skin') >= SKIN_DARK_UNLISTED_MIN;
    },
    fixture: (b) => withStats(withAxes(b, { skinTone: '標準' }), { counts: { dark_skin: 150 } }),
  },
  ...LOOKS_TAGS.map(
    ({ ruleId, value, tag }): Rule => ({
      id: ruleId,
      kind: 'Danbooru',
      describe: `${tag} が solo 投稿の ${LOOKS_MISSING_MIN * 100}% 以上に付いているのに、looks に ${value} が無い`,
      violates: ({ c, stats: s }) => evaluable(s) && !has(c.axes.looks, value) && rateOf(s, tag) >= LOOKS_MISSING_MIN,
      fixture: (b) => withStats(withAxes(b, { looks: [] }), { counts: { [tag]: 180 } }),
    }),
  ),
];

/**
 * 入れなかったルール（2026-10-05 の下調べで候補に挙がったが、誤検出になるか、矛盾と言えないため）。
 *
 * Danbooru の語彙のずれが大きいもの:
 *   - outfit=巫女: 霊夢は nontraditional_miko で、miko が付かない。
 *   - outfit=軍服: 艦これの制服は military_uniform が付かず、school_uniform や sailor_collar になる。
 *   - outfit=制服 / メイド / 和服・着物: 衣装違いの絵が多く、出現率が作品の事情で大きく振れる。
 *   - looks=ツインテール: side_ponytail・twin_braids など近いタグへ割れる。
 *   - looks の「あるのに実測が少ない」方向全般: 衣装違い・ヘアアレンジ違いの絵が多いだけで正当なことが多い。
 *   - looks=眼鏡・眼帯: 該当が数体しかなく、しきい値の根拠を作れない。
 *   - looks=角: demon_horns・oni_horns・skin-covered_horns など複数タグに割れ、horns 単独では漏れる。
 * 内部矛盾と言えないもの（軸の設計上、両立するのが普通）:
 *   - affiliationKind=非人間・その他 かつ species=人間: 「その他」は受け皿の値で、人間も入る（35体）。
 *   - roles=姉 かつ ageFeel=幼い / roles=妹 かつ ageFeel=熟れた: 年齢感は役割と独立（見た目の幼い姉は普通にいる）。
 *   - build=華奢 かつ bust=とても大きい / build=むっちり かつ bust=小さい: 体格と胸は別軸に分けた設計。
 *   - occupation=兵士・軍人 かつ affiliationKind≠軍・組織: 冒険者・学生の兵士など、設定上ありうる（22体）。
 *   - genderExpression=男性 かつ bust が大きい: 男性の bust は胸板の意味で使われている（ゾロ）。
 */

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

function statsOf(id: string): StatsEntry | null {
  return stats.entries[id] ?? null;
}

/** ルールごとの、今の違反キャラ id（characters.json の並び順）。 */
const violationsByRule: Record<string, string[]> = Object.fromEntries(
  RULES.map((rule) => [rule.id, characters.filter((c) => rule.violates({ c, stats: statsOf(c.id) })).map((c) => c.id)]),
);

const nameOf = (id: string): string => {
  const c = characters.find((x) => x.id === id);
  return c ? `${id}(${c.name})` : id;
};

/** 中立なベース。どのルールにも触れない。 */
const BASE: Ctx = {
  c: {
    id: 'base',
    name: 'ベース',
    aliases: [],
    series: 'テスト',
    dlsiteQuery: null,
    hitomiQuery: null,
    axes: {
      genderExpression: '女性',
      ageFeel: '同年代',
      build: '標準',
      bust: '標準',
      personality: ['クール'],
      roles: [],
      distance: '中立',
      looks: [],
      hairColor: ['黒'],
      skinTone: '標準',
      outfit: [],
      species: '人間',
      mood: [],
      combat: '戦う',
      affiliationKind: '社会人',
      affiliationName: null,
      stature: '標準',
      occupation: [],
    },
    reviewed: true,
    provisional: false,
    imagePath: null,
    imageApproved: false,
  },
  stats: {
    tag: 'base',
    fetchedAt: '2026-10-05',
    soloPosts: 200,
    hairPosts: 180,
    bustPosts: 150,
    counts: {
      black_hair: 170,
      brown_hair: 8,
      medium_breasts: 130,
      large_breasts: 10,
      long_hair: 50,
      dark_skin: 4,
      animal_ears: 4,
      tail: 4,
    },
  },
};

// ---------------------------------------------------------------------------
// BF1. 許可リスト
// ---------------------------------------------------------------------------

describe('BF1. 品質ゲートの許可リスト（data/bayes/quality-allowlist.json）', () => {
  const ruleIds = new Set(RULES.map((r) => r.id));
  const charIds = new Set(characters.map((c) => c.id));

  it('ルール id が重複しない', () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
  });

  it('許可リストのルール名は、定義済みのルールだけ', () => {
    const unknown = Object.keys(allowlist.rules).filter((id) => !ruleIds.has(id));
    expect(unknown, `未定義のルールへの許可があります: ${unknown.join(', ')}`).toEqual([]);
  });

  it('許可されているキャラは characters.json に実在する', () => {
    const missing = Object.entries(allowlist.rules).flatMap(([rule, ids]) =>
      Object.keys(ids).filter((id) => !charIds.has(id)).map((id) => `${rule}: ${id}`),
    );
    expect(missing, '存在しないキャラ id への許可があります').toEqual([]);
  });

  it('理由の無い許可は認めない（理由が空・空白だけの許可は落とす）', () => {
    const noReason = Object.entries(allowlist.rules).flatMap(([rule, ids]) =>
      Object.entries(ids)
        .filter(([, reason]) => typeof reason !== 'string' || reason.trim() === '')
        .map(([id]) => `${rule}: ${id}`),
    );
    expect(noReason, `理由の無い許可: ${noReason.join(', ')}\n→ 例外にする理由を書くこと。`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BF2. Danbooru 統計ファイルの整合
// ---------------------------------------------------------------------------

describe('BF2. data/bayes/danbooru-stats.json（Danbooru の実測をタグの出現数だけにしたもの）', () => {
  const REFRESH_HINT =
    '→ node scripts/bayes/export-danbooru-stats.mjs --state-dir <state ディレクトリ> で書き出し直すこと\n' +
    '  （Danbooru キャッシュは state/bayes-pipeline/danbooru/。無ければ先に scripts/bayes/sample-posts.mjs）。';

  it('グループのタグが questions.json（パイプラインの語彙）と一致し、対応表が過不足なく覆っている', () => {
    expect(stats.groups.hairColor).toEqual(questions.groups['hair-color'].coverageTags);
    expect(stats.groups.bust).toEqual(questions.groups['breast-size'].coverageTags);
    expect(Object.keys(HAIR_TAG_TO_VALUE).sort(), '髪色タグ→軸の値の対応表').toEqual([...stats.groups.hairColor].sort());
    expect(Object.keys(BUST_TAG_TO_VALUE).sort(), '胸タグ→軸の値の対応表').toEqual([...stats.groups.bust].sort());
  });

  it('ルールが使う単体タグはすべて書き出し対象に入っている', () => {
    const used = ['dark_skin', 'tan', ...LOOKS_TAGS.map((l) => l.tag)];
    const missing = used.filter((t) => !stats.singleTags.includes(t));
    expect(missing, `書き出し対象(SINGLE_TAGS)に無いタグ: ${missing.join(', ')}`).toEqual([]);
  });

  it('対応表の値は軸の許容値の中にある（typo 検出）', () => {
    const hair = new Set(['黒', '白', '金', '茶', '赤', '青', '緑', '桃', '紫', '銀', '橙']);
    for (const v of Object.values(HAIR_TAG_TO_VALUE)) expect(hair.has(v), v).toBe(true);
    for (const [a, b] of HAIR_NEAR_PAIRS) {
      expect(hair.has(a) && hair.has(b), `${a}/${b}`).toBe(true);
    }
    for (const v of Object.values(BUST_TAG_TO_VALUE)) expect(BUST_ORDER.includes(v), v).toBe(true);
    for (const [, , reason] of HAIR_NEAR_PAIRS) expect(reason.trim()).not.toBe('');
  });

  it('各エントリは、tag-map.json で今そのキャラに確定しているタグの統計である', () => {
    const stale = Object.entries(stats.entries)
      .filter(([id, e]) => tagMap.entries[id]?.tag !== e.tag)
      .map(([id, e]) => `${id}: 統計のタグ=${e.tag} / 今のタグ=${tagMap.entries[id]?.tag ?? 'キャラ無し'}`);
    expect(stale, `タグの対応付けが変わったのに統計が古いキャラがあります。\n${REFRESH_HINT}`).toEqual([]);
  });

  it('Danbooru タグが確定している全キャラの統計がある（新しいキャラが検査をすり抜けない）', () => {
    const missing = characters
      .filter((c) => tagMap.entries[c.id]?.tag != null && !(c.id in stats.entries))
      .map((c) => c.id);
    expect(missing, `統計の無いキャラがあります: ${missing.join(', ')}\n${REFRESH_HINT}`).toEqual([]);
  });

  it('数値だけを持つ（件数は整数で、母数を超えない。文章や投稿 ID を持たない）', () => {
    const allowedKeys = ['tag', 'fetchedAt', 'soloPosts', 'hairPosts', 'bustPosts', 'counts'].sort();
    const known = new Set([...stats.groups.hairColor, ...stats.groups.bust, ...stats.singleTags]);
    const problems: string[] = [];
    for (const [id, e] of Object.entries(stats.entries)) {
      if (JSON.stringify(Object.keys(e).sort()) !== JSON.stringify(allowedKeys)) problems.push(`${id}: キーが想定外`);
      for (const k of ['soloPosts', 'hairPosts', 'bustPosts'] as const) {
        if (!Number.isInteger(e[k]) || e[k] < 0) problems.push(`${id}: ${k} が非負の整数でない`);
      }
      if (e.hairPosts > e.soloPosts || e.bustPosts > e.soloPosts) problems.push(`${id}: グループの母数が solo 投稿数を超える`);
      for (const [tag, n] of Object.entries(e.counts)) {
        if (!known.has(tag)) problems.push(`${id}: 未知のタグ ${tag}`);
        if (!Number.isInteger(n) || n <= 0 || n > e.soloPosts) problems.push(`${id}: ${tag}=${n} が範囲外`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('solo 投稿が十分あり判定できるキャラが大半を占める（書き出しの欠損・打ち切りの検出）', () => {
    const entries = Object.values(stats.entries);
    const ok = entries.filter((e) => e.soloPosts >= MIN_SOLO_POSTS).length;
    expect(ok / entries.length, `判定できるキャラ ${ok}/${entries.length}`).toBeGreaterThanOrEqual(0.9);
  });

  it('summarizePosts は solo 投稿だけを数え、グループの分母は「そのグループのタグを持つ投稿」である', () => {
    const groups = { hairColor: ['black_hair', 'red_hair'], bust: ['large_breasts'] };
    const posts = [
      { id: 1, tags: ['solo', 'black_hair', 'long_hair', 'large_breasts'] },
      { id: 2, tags: ['solo', 'black_hair', 'red_hair'] },
      { id: 3, tags: ['solo', 'long_hair'] },
      { id: 4, tags: ['2girls', 'black_hair', 'long_hair', 'large_breasts'] },
    ];
    expect(summarizePosts(posts, groups, ['long_hair', 'tail'])).toEqual({
      soloPosts: 3,
      hairPosts: 2,
      bustPosts: 1,
      counts: { black_hair: 2, large_breasts: 1, long_hair: 2, red_hair: 1 },
    });
  });
});

// ---------------------------------------------------------------------------
// BF3. ルールごとのラチェット
// ---------------------------------------------------------------------------

describe('BF3. 軸の矛盾と Danbooru 実測との食い違い（新しい違反だけを止めるラチェット）', () => {
  describe.each(RULES.map((r) => [r.id, r] as const))('%s', (_id, rule) => {
    const violators = violationsByRule[rule.id];
    const allowed = allowlist.rules[rule.id] ?? {};

    it('許可リストに無い新しい違反が無い', () => {
      const fresh = violators.filter((id) => !(id in allowed)).map(nameOf);
      expect(
        fresh,
        `[${rule.kind}] ${rule.describe}\n` +
          '新しい違反があります。次のどちらかで直すこと。\n' +
          '  - data/characters.json の軸の値を直す（Danbooru との食い違いなら、実測を見て査読値を見直す）\n' +
          '  - 作品の設定上の正当な例外なら、data/bayes/quality-allowlist.json にこのルールとキャラを理由つきで足す\n' +
          'この件を既存の違反としてまとめて許可リストへ入れてはいけない。',
      ).toEqual([]);
    });

    it('許可リストに、もう違反でないキャラが残っていない', () => {
      const stale = Object.keys(allowed).filter((id) => !violators.includes(id)).map(nameOf);
      expect(
        stale,
        `[${rule.kind}] ${rule.describe}\n` +
          '直った（または判定できなくなった）のに許可が残っています。許可リストから消すこと。\n' +
          '残すと、あとで同じ違反が再発しても気付けなくなる。',
      ).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// BF4. ルール自身の検出力
// ---------------------------------------------------------------------------

describe('BF4. ルールの検出力（ルールが常に何も検出しない状態を許さない）', () => {
  it('中立なベースはどのルールにも触れない', () => {
    const hit = RULES.filter((r) => r.violates(BASE)).map((r) => r.id);
    expect(hit).toEqual([]);
  });

  it.each(RULES.map((r) => [r.id, r] as const))('%s: 違反の例を実際に検出する', (_id, rule) => {
    expect(rule.violates(rule.fixture(BASE))).toBe(true);
  });

  it('solo 投稿が少ないキャラ、統計の無いキャラは Danbooru のルールで判定しない', () => {
    const thin = withStats(BASE, { soloPosts: MIN_SOLO_POSTS - 1 });
    const none: Ctx = { ...BASE, stats: null };
    for (const rule of RULES.filter((r) => r.kind === 'Danbooru')) {
      expect(rule.violates({ ...rule.fixture(thin), stats: thin.stats }), `${rule.id}(少ない)`).toBe(false);
      expect(rule.violates({ ...rule.fixture(BASE), stats: null }), `${rule.id}(統計なし)`).toBe(false);
    }
    expect(none.stats).toBeNull();
  });

  it('髪色: 境界色の組は判定しない／査読値の色が実測に 5% を超えて残るなら判定しない', () => {
    const rule = RULES.find((r) => r.id === 'danbooru-hair-color')!;
    // 査読=黒、実測=茶 は境界色の組（焦げ茶）
    const near = withStats(BASE, { counts: { black_hair: 2, brown_hair: 178 } });
    expect(rule.violates(near)).toBe(false);
    // 査読=黒、実測=赤 90% だが、黒が 6% 残る
    const residual = withStats(BASE, { counts: { black_hair: 11, red_hair: 169 } });
    expect(rule.violates(residual)).toBe(false);
  });

  it('allowlist 以外で件数を数えておく（既存の違反数がこのテストで分かる）', () => {
    // 数そのものは固定しない（直すたびに増減する）。評価不能で全ルール 0 件になる事故だけを見る。
    const total = Object.values(violationsByRule).reduce((n, ids) => n + ids.length, 0);
    expect(total).toBeGreaterThan(0);
  });
});
