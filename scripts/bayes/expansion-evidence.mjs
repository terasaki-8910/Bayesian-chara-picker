#!/usr/bin/env node
/**
 * 1000体拡張で新規に足す398体それぞれについて「根拠の束（evidence pack）」を
 * 1ファイルにまとめる。下書き担当（LLM）はこのファイルだけを読んで16軸を埋める
 * ——Web検索はしない運用に変えるための前段スクリプト（2026-10-06導入）。
 *
 * 動機: 前回「全軸を出典の引用だけで埋める・Web検索で調べる」と頼んだところ、
 * 必須軸がほぼ空になり1組あたり30万トークン超を消費した。機械で測れるもの
 * （Danbooruタグの比率）は先にここで計算し、テキストの根拠（ニコニコ本文・
 * LLM抽出の引用・前回下書きのWeb引用・Danbooru wiki本文）もまとめて渡す。
 *
 * 入力:
 *   --input <パス>  state/expansion/expansion-drafts.json 相当（配列）
 *   --prior <パス>  前回下書き（配列。evidence[].source で引用元を判別）。省略可
 *                   （省略時は priorEvidence が全件空になる）
 *   --char <id>     単体のみ処理（動作確認用）
 *   --force         Danbooru wikiキャッシュを無視して再取得
 *   --self-check    下記の自己点検モードのみ実行し、他の引数は無視する
 *
 * 出力:
 *   state/expansion/evidence/<id>.json  キャラごとの根拠の束
 *   state/expansion/evidence/_index.json 件数のまとめ
 *   state/expansion/wiki/<safe>.json    Danbooru wiki本文のキャッシュ（再実行で再利用）
 *
 * 自己点検（--self-check）: measured の計算規則を既存の査読済みキャラ（488体、
 * state/bayes-pipeline/danbooru/<id>.json の投稿で計算）にかけ、査読済みの値との
 * 一致率を出す。測定規則自体の精度チェックであり、新規キャラの出力とは独立。
 *
 * Danbooru wikiの取得について: scripts/bayes/danbooru-client.mjs の
 * fetchWikiPage は「wikiページが存在しない(404)」も「通信エラー」も等しく
 * null に潰してしまうため、再試行の判断に使えない（失敗を黒塗りにしてしまう）。
 * ここでは danbooruFetch を直接呼び、エラーメッセージの status=404 だけを
 * 「正常な無し」として確定させ、それ以外（通信断・5xx等）だけを再試行対象にする
 * ——「残った失敗を数える」という要件に応えるための意図的な設計判断。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDanbooruFetcher } from './danbooru-client.mjs';

// ---- 固定パラメータ ----

/** P（measured/hints の計算対象）は solo タグ付き投稿がこれ以上あればそちらを使う。 */
const SOLO_MIN = 50;

/** Danbooru wiki取得の再試行回数・待機時間（scripts/bayes/sample-posts.mjsと同じ値）。 */
const WIKI_MAX_RETRIES = 3;
const WIKI_RETRY_BACKOFF_MS = 5_000;

/** ニコニコ本文・Danbooru wiki本文を根拠に渡す際の先頭からの文字数上限。 */
const NICONICO_TEXT_LIMIT = 4_000;
const DANBOORU_WIKI_TEXT_LIMIT = 2_500;

/** 髪色: タグ群→ラベル。並びは出力配列の並び順そのもの。灰・銀は1色に統合する。 */
const HAIR_COLOR_GROUPS = [
  { tags: ['black_hair'], label: '黒' },
  { tags: ['white_hair'], label: '白' },
  { tags: ['blonde_hair'], label: '金' },
  { tags: ['brown_hair'], label: '茶' },
  { tags: ['red_hair'], label: '赤' },
  { tags: ['blue_hair'], label: '青' },
  { tags: ['green_hair'], label: '緑' },
  { tags: ['pink_hair'], label: '桃' },
  { tags: ['purple_hair'], label: '紫' },
  { tags: ['grey_hair', 'silver_hair'], label: '銀' },
  { tags: ['orange_hair'], label: '橙' },
];
/** 髪色タグを1つ以上持つ投稿数（H）がこれ未満なら hairColor は null。 */
const HAIR_COLOR_MIN_COVERAGE = 30;
/** H に対する割合がこれ以上の色を全部採用する（最上位色は閾値未満でも必ず入れる）。 */
const HAIR_COLOR_SHARE_THRESHOLD = 0.3;

/** 胸のサイズ: タグ群→ラベル。 */
const BUST_GROUPS = [
  { tags: ['flat_chest', 'small_breasts'], label: '小さい' },
  { tags: ['medium_breasts'], label: '標準' },
  { tags: ['large_breasts'], label: '大きい' },
  { tags: ['huge_breasts', 'gigantic_breasts'], label: 'とても大きい' },
];
/** サイズタグを1つ以上持つ投稿数（B）がこれ未満なら bust は null。 */
const BUST_MIN_COVERAGE = 30;

const SKIN_TONE_DARK_TAGS = ['dark_skin', 'tan'];
const SKIN_TONE_PALE_TAGS = ['pale_skin'];
const SKIN_TONE_DARK_THRESHOLD = 0.3;
const SKIN_TONE_PALE_THRESHOLD = 0.2;

/** 見た目の特徴: タグ→ラベル・閾値（長髪だけ0.4、他は0.3）。並びは出力配列の並び順。 */
const LOOKS_GROUPS = [
  { tags: ['glasses'], label: '眼鏡', threshold: 0.3 },
  { tags: ['animal_ears'], label: 'ケモミミ', threshold: 0.3 },
  { tags: ['horns'], label: '角', threshold: 0.3 },
  { tags: ['tail'], label: '尻尾', threshold: 0.3 },
  { tags: ['long_hair'], label: '長髪', threshold: 0.4 },
  { tags: ['twintails'], label: 'ツインテール', threshold: 0.3 },
  { tags: ['eyepatch'], label: '眼帯', threshold: 0.3 },
];

/** 服装: タグ群→ラベル。並びは出力配列の並び順。閾値は全部0.2。 */
const OUTFIT_GROUPS = [
  { tags: ['school_uniform', 'serafuku'], label: '制服' },
  { tags: ['maid'], label: 'メイド' },
  { tags: ['miko'], label: '巫女' },
  { tags: ['nurse'], label: 'ナース' },
  { tags: ['magical_girl'], label: '魔法少女' },
  { tags: ['military_uniform'], label: '軍服' },
  { tags: ['office_lady'], label: 'OL' },
  { tags: ['kimono', 'japanese_clothes'], label: '和服・着物' },
];
const OUTFIT_THRESHOLD = 0.2;

const GENDER_EXPRESSION_THRESHOLD = 0.2;

/** hints.tagFreq で参考値として出すタグ一覧（0は省く）。 */
const TAG_FREQ_LIST = [
  'petite', 'skinny', 'curvy', 'plump', 'thick_thighs', 'wide_hips', 'muscular_female',
  'child', 'loli', 'mature_female', 'aged_up', 'tall_female',
  'animal_ears', 'tail', 'pointy_ears', 'horns', 'demon_girl', 'demon_tail', 'demon_wings',
  'robot', 'android', 'robot_joints', 'mechanical_parts', 'ghost', 'halo', 'wings',
  'school_uniform', 'serafuku', 'military_uniform', 'office_lady', 'suit', 'armor',
  'weapon', 'holding_weapon', 'sword', 'gun', 'katana', 'staff', 'polearm', 'rigging',
  'smug', 'expressionless', 'smile', 'blush',
];

/** hints.topTags から除く定型タグ（構図・表情の基本語で、個性の手がかりにならない）。 */
const TOP_TAGS_EXCLUDE = new Set([
  'solo', '1girl', 'looking_at_viewer', 'simple_background', 'white_background',
  'upper_body', 'full_body', 'closed_mouth', 'open_mouth', 'smile', 'blush', 'standing', 'holding',
]);
const TOP_TAGS_LIMIT = 40;

/** 既存488体での的中率（固定の参考値。計算はしない。下書き担当への注意書き）。 */
const CALIBRATION_NOTE =
  '既存488体のレビュー実績との的中率（参考値）: genderExpressionの規則99%、' +
  'combatの作品慣例94%、speciesの規則75%、statureのタグ68%、' +
  'affiliationKindの作品慣例69%、ageFeelのタグ59%、buildのタグは多数決以下（ほぼ当たらない）。';

/** llm-extract.json の軸一覧（scripts/bayes/llm-extract.mjs の LLM_AXIS_KEYS と同じ）。 */
const LLM_AXIS_KEYS = [
  'personality', 'mood', 'species', 'combat', 'distance', 'affiliationKind', 'roles',
  'ageFeel', 'build', 'stature', 'occupation',
];
/** 複数値で持つ軸。 */
const LLM_MULTI_VALUE_AXES = new Set(['roles', 'occupation']);

/** seriesConvention で集計する単一値軸・複数値軸。 */
const SERIES_SINGLE_AXES = ['combat', 'affiliationKind', 'species', 'ageFeel', 'build', 'stature'];
const SERIES_MULTI_AXES = ['personality', 'occupation'];

/** prior の evidence のうち、この接頭辞で始まる source はDanbooru由来として除く
 * （このスクリプトが同じ計算をやり直すため、重複して渡さない）。 */
const PRIOR_SAMPLES_SOURCE_PREFIX = 'state/expansion/samples';

// ---- 小さいユーティリティ ----

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function loadJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (_err) {
    return null;
  }
}

/** state/expansion/samples・state/expansion/wiki のファイル名に使う安全化。 */
function safeTagName(tag) {
  return tag.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

// ---- Danbooru投稿の読み込み・P（計算対象）の選定 ----

/**
 * state/expansion/samples/<safe>.json を優先し、無ければ
 * state/bayes-pipeline/danbooru/<id>.json にフォールバックする。どちらも無ければ空配列。
 * @returns {{ id: number, tags: string[] }[]}
 */
export function loadPosts(samplesDir, danbooruCacheDir, id, danbooruTag) {
  const sample = loadJsonOrNull(join(samplesDir, `${safeTagName(danbooruTag)}.json`));
  if (Array.isArray(sample?.posts)) return sample.posts;
  const fallback = loadJsonOrNull(join(danbooruCacheDir, `${id}.json`));
  if (Array.isArray(fallback?.posts)) return fallback.posts;
  return [];
}

/**
 * P = solo タグ付き投稿が50件以上ならその solo 投稿、そうでなければ全投稿。
 * @param {{ id: number, tags: string[] }[]} posts
 */
export function selectP(posts) {
  const soloPosts = posts.filter((p) => p.tags.includes('solo'));
  const soloUsed = soloPosts.length >= SOLO_MIN;
  return { P: soloUsed ? soloPosts : posts, soloUsed };
}

// ---- measured の計算 ----

/** @param {{ id: number, tags: string[] }[]} posts */
function buildTagCounts(posts) {
  const counts = new Map();
  for (const post of posts) {
    for (const tag of post.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
}

/**
 * @param {{ id: number, tags: string[] }[]} P
 * @returns {{ P: typeof P, n: number, tagCounts: Map<string, number> }}
 */
export function buildContext(P) {
  return { P, n: P.length, tagCounts: buildTagCounts(P) };
}

/** タグ群（1個なら tagCounts を引くだけ、2個以上ならORの投稿数をPから数える）の件数。 */
function countGroup(ctx, tags) {
  if (tags.length === 1) return ctx.tagCounts.get(tags[0]) ?? 0;
  return ctx.P.filter((post) => tags.some((t) => post.tags.includes(t))).length;
}

/** 髪色タグを1つ以上持つ投稿数（H）。 */
function hairColorCoverage(ctx) {
  const allTags = HAIR_COLOR_GROUPS.flatMap((g) => g.tags);
  return ctx.P.filter((post) => allTags.some((t) => post.tags.includes(t))).length;
}

/** 胸サイズタグを1つ以上持つ投稿数（B）。 */
function bustCoverage(ctx) {
  const allTags = BUST_GROUPS.flatMap((g) => g.tags);
  return ctx.P.filter((post) => allTags.some((t) => post.tags.includes(t))).length;
}

/**
 * @returns {{ value: string[] | null, top: string | null, shares: Record<string, number>, coverage: number }}
 */
export function computeHairColor(ctx) {
  const H = hairColorCoverage(ctx);
  const shares = {};
  for (const g of HAIR_COLOR_GROUPS) shares[g.label] = H > 0 ? round2(countGroup(ctx, g.tags) / H) : 0;
  if (H < HAIR_COLOR_MIN_COVERAGE) return { value: null, top: null, shares, coverage: H };

  let top = null;
  let topShare = -1;
  for (const g of HAIR_COLOR_GROUPS) {
    if (shares[g.label] > topShare) {
      topShare = shares[g.label];
      top = g.label;
    }
  }
  const value = HAIR_COLOR_GROUPS.map((g) => g.label).filter(
    (label) => shares[label] >= HAIR_COLOR_SHARE_THRESHOLD || label === top,
  );
  return { value, top, shares, coverage: H };
}

/** @returns {{ value: string | null, shares: Record<string, number>, coverage: number }} */
export function computeBust(ctx) {
  const B = bustCoverage(ctx);
  const shares = {};
  for (const g of BUST_GROUPS) shares[g.label] = B > 0 ? round2(countGroup(ctx, g.tags) / B) : 0;
  if (B < BUST_MIN_COVERAGE) return { value: null, shares, coverage: B };

  let top = null;
  let topShare = -1;
  for (const g of BUST_GROUPS) {
    if (shares[g.label] > topShare) {
      topShare = shares[g.label];
      top = g.label;
    }
  }
  return { value: top, shares, coverage: B };
}

/** @returns {{ value: string, shares: Record<string, number> }} */
export function computeSkinTone(ctx) {
  const darkRatio = ctx.n > 0 ? countGroup(ctx, SKIN_TONE_DARK_TAGS) / ctx.n : 0;
  const paleRatio = ctx.n > 0 ? countGroup(ctx, SKIN_TONE_PALE_TAGS) / ctx.n : 0;
  const shares = { 褐色: round2(darkRatio), 色白: round2(paleRatio) };
  const value = darkRatio >= SKIN_TONE_DARK_THRESHOLD ? '褐色' : paleRatio >= SKIN_TONE_PALE_THRESHOLD ? '色白' : '標準';
  return { value, shares };
}

/** @returns {{ value: string[], shares: Record<string, number> }} */
export function computeLooks(ctx) {
  const shares = {};
  const value = [];
  for (const g of LOOKS_GROUPS) {
    const ratio = ctx.n > 0 ? countGroup(ctx, g.tags) / ctx.n : 0;
    shares[g.label] = round2(ratio);
    if (ratio >= g.threshold) value.push(g.label);
  }
  return { value, shares };
}

/** @returns {{ value: string[], shares: Record<string, number> }} */
export function computeOutfit(ctx) {
  const shares = {};
  const value = [];
  for (const g of OUTFIT_GROUPS) {
    const ratio = ctx.n > 0 ? countGroup(ctx, g.tags) / ctx.n : 0;
    shares[g.label] = round2(ratio);
    if (ratio >= OUTFIT_THRESHOLD) value.push(g.label);
  }
  return { value, shares };
}

/** @returns {{ value: string, shares: Record<string, number> }} */
export function computeGenderExpression(ctx) {
  const otokonokoRatio = ctx.n > 0 ? countGroup(ctx, ['otoko_no_ko']) / ctx.n : 0;
  const futanariRatio = ctx.n > 0 ? countGroup(ctx, ['futanari']) / ctx.n : 0;
  const shares = { おとこの娘: round2(otokonokoRatio), ふたなり: round2(futanariRatio) };
  const value =
    otokonokoRatio >= GENDER_EXPRESSION_THRESHOLD
      ? 'おとこの娘'
      : futanariRatio >= GENDER_EXPRESSION_THRESHOLD
        ? 'ふたなり'
        : '女性';
  return { value, shares };
}

/**
 * measured・measuredShares をまとめて計算する。raw は自己点検（--self-check）が
 * top/coverage 等の内部値を使うための補助戻り値で、evidence ファイルには出さない。
 */
export function computeMeasured(ctx) {
  const hair = computeHairColor(ctx);
  const bust = computeBust(ctx);
  const skin = computeSkinTone(ctx);
  const looks = computeLooks(ctx);
  const outfit = computeOutfit(ctx);
  const gender = computeGenderExpression(ctx);
  return {
    measured: {
      hairColor: hair.value,
      bust: bust.value,
      skinTone: skin.value,
      looks: looks.value,
      outfit: outfit.value,
      genderExpression: gender.value,
    },
    measuredShares: {
      hairColor: hair.shares,
      bust: bust.shares,
      skinTone: skin.shares,
      looks: looks.shares,
      outfit: outfit.shares,
      genderExpression: gender.shares,
      coverage: { hairColor: hair.coverage, bust: bust.coverage },
    },
    raw: { hair, bust, skin, looks, outfit, gender },
  };
}

// ---- hints の計算 ----

/** @returns {Record<string, number>} */
export function computeTagFreq(ctx) {
  const freq = {};
  for (const tag of TAG_FREQ_LIST) {
    const ratio = ctx.n > 0 ? round3((ctx.tagCounts.get(tag) ?? 0) / ctx.n) : 0;
    if (ratio > 0) freq[tag] = ratio;
  }
  return freq;
}

/** @returns {string} SPECIES_VALUES（src/data/schema.ts）のいずれか。 */
export function computeSpeciesSuggestion(ctx) {
  const ratio = (tag) => (ctx.n > 0 ? (ctx.tagCounts.get(tag) ?? 0) / ctx.n : 0);
  const mechanicalSum = ratio('robot') + ratio('android') + ratio('robot_joints') + ratio('mechanical_parts');
  const demonSum = ratio('horns') + ratio('demon_girl') + ratio('demon_tail') + ratio('demon_wings');
  if (mechanicalSum >= 0.5) return '機械';
  if (ratio('pointy_ears') >= 0.5 && ratio('animal_ears') < 0.5) return 'エルフ';
  if (ratio('animal_ears') >= 0.5 || ratio('tail') >= 0.5) return '獣人';
  if (demonSum >= 0.5) return '魔族';
  if (ratio('ghost') >= 0.5) return '不死';
  return '人間';
}

/** @returns {{ tag: string, share: number }[]} 上位40件（定型タグを除く）。 */
export function computeTopTags(ctx) {
  if (ctx.n === 0) return [];
  return [...ctx.tagCounts.entries()]
    .filter(([tag]) => !TOP_TAGS_EXCLUDE.has(tag))
    .map(([tag, count]) => ({ tag, share: round3(count / ctx.n) }))
    .sort((a, b) => b.share - a.share || a.tag.localeCompare(b.tag))
    .slice(0, TOP_TAGS_LIMIT);
}

// ---- seriesConvention（既存査読済みキャラの作品内訳） ----

function emptySeriesConvention() {
  const entry = { n: 0 };
  for (const axis of SERIES_SINGLE_AXES) entry[axis] = {};
  for (const axis of SERIES_MULTI_AXES) entry[axis] = {};
  return entry;
}

/**
 * series文字列 → { n, combat:{値:件数}, ... } のマップを作る。null/空配列は数えない。
 * @param {object[]} reviewedCharacters data/characters.json の reviewed===true のもの
 */
export function buildSeriesConventionMap(reviewedCharacters) {
  const map = new Map();
  for (const c of reviewedCharacters) {
    if (!map.has(c.series)) map.set(c.series, emptySeriesConvention());
    const entry = map.get(c.series);
    entry.n += 1;
    for (const axis of SERIES_SINGLE_AXES) {
      const value = c.axes?.[axis];
      if (value === null || value === undefined) continue;
      entry[axis][value] = (entry[axis][value] ?? 0) + 1;
    }
    for (const axis of SERIES_MULTI_AXES) {
      for (const value of c.axes?.[axis] ?? []) {
        entry[axis][value] = (entry[axis][value] ?? 0) + 1;
      }
    }
  }
  return map;
}

// ---- text（ニコニコ・LLM引用・prior引用・Danbooru wiki） ----

function loadNiconicoText(id, expectedTitle, niconicoCacheDir) {
  if (!expectedTitle) return null;
  const cached = loadJsonOrNull(join(niconicoCacheDir, `${id}.json`));
  if (!cached || cached.title !== expectedTitle || typeof cached.text !== 'string') return null;
  return cached.text.slice(0, NICONICO_TEXT_LIMIT);
}

/**
 * llm-extract.json の verified===true の軸を、state/bayes-pipeline/llm/<id>.json の
 * verification[] から引用文を添えて並べる。複数値軸（roles/occupation）は値ごとに
 * 1件に分解する——quoteは値ごとに別物であり、まとめて1個の引用で代表させると
 * どの値の根拠か分からなくなるため（scripts/bayes/review-hints.mjs の
 * evidenceForCandidate と同じ、role単位でのquote照合方式）。
 * @returns {{ axis: string, value: string, verified: true, confidence: string, quote: string | null }[]}
 */
export function buildLlmEvidence(llmEntry, llmState) {
  if (!llmEntry?.axes) return [];
  const verification = llmState?.verification ?? [];
  const items = [];
  for (const axisKey of LLM_AXIS_KEYS) {
    const axisResult = llmEntry.axes[axisKey];
    if (!axisResult || axisResult.verified !== true) continue;
    if (LLM_MULTI_VALUE_AXES.has(axisKey)) {
      for (const value of axisResult.values ?? []) {
        const match = verification.find((v) => v.axis === axisKey && v.role === value && v.matched === true);
        items.push({ axis: axisKey, value, verified: true, confidence: axisResult.confidence, quote: match?.quote ?? null });
      }
    } else {
      const match = verification.find((v) => v.axis === axisKey && v.matched === true);
      items.push({
        axis: axisKey,
        value: axisResult.value,
        verified: true,
        confidence: axisResult.confidence,
        quote: match?.quote ?? null,
      });
    }
  }
  return items;
}

/** prior配列（tag/danbooruTagどちらでも可）を danbooruTag → エントリ配列 で引けるようにする。 */
export function buildPriorIndex(priorList) {
  const map = new Map();
  for (const entry of priorList ?? []) {
    const key = entry.danbooruTag ?? entry.tag;
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  }
  return map;
}

/** priorの同じタグのevidenceのうち、Danbooru由来（source が samples/ 始まり）を除く。 */
export function selectPriorEvidence(priorIndex, danbooruTag) {
  const entries = priorIndex.get(danbooruTag) ?? [];
  const result = [];
  for (const entry of entries) {
    for (const ev of entry.evidence ?? []) {
      if ((ev.source ?? '').startsWith(PRIOR_SAMPLES_SOURCE_PREFIX)) continue;
      result.push(ev);
    }
  }
  return result;
}

// ---- Danbooru wiki取得（キャッシュ・再試行） ----

/**
 * wiki_pages/<tag>.json を直接呼ぶ（ファイル冒頭のコメント参照: fetchWikiPageは
 * 404と通信エラーを区別できないため使わない）。404は正常な「無し」としてnullを返し、
 * それ以外の失敗は呼び出し側が再試行できるよう例外をそのまま投げる。
 */
async function fetchWikiBodyDiscriminating(danbooruFetch, tag) {
  const path = `/wiki_pages/${encodeURIComponent(tag)}.json`;
  try {
    const page = await danbooruFetch(path);
    return page?.body ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('status=404')) return null; // wikiページが存在しない（正常）
    throw err;
  }
}

/**
 * キャッシュ（state/expansion/wiki/<safe>.json）があれば使い、無ければ取得して保存する。
 * 取得に失敗した場合はキャッシュを書かない（次回実行時にまた取得を試みられるように
 * する——「確認できていない」と「無いと確認済み」を区別する）。
 * @returns {Promise<{ body: string | null, failed: boolean, error?: string }>}
 */
export async function getWikiBody(danbooruFetch, tag, wikiCacheDir, { force = false } = {}) {
  const cachePath = join(wikiCacheDir, `${safeTagName(tag)}.json`);
  if (!force) {
    const cached = loadJsonOrNull(cachePath);
    if (cached) return { body: cached.body ?? null, failed: false };
  }

  let lastErr;
  for (let attempt = 1; attempt <= WIKI_MAX_RETRIES; attempt += 1) {
    try {
      const body = await fetchWikiBodyDiscriminating(danbooruFetch, tag);
      writeFileSync(cachePath, `${JSON.stringify({ tag, fetchedAt: new Date().toISOString(), body }, null, 2)}\n`);
      return { body, failed: false };
    } catch (err) {
      lastErr = err;
      if (attempt < WIKI_MAX_RETRIES) await sleep(WIKI_RETRY_BACKOFF_MS);
    }
  }
  return { body: null, failed: true, error: lastErr instanceof Error ? lastErr.message : String(lastErr) };
}

// ---- メイン処理 ----

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

  if (args.includes('--self-check')) {
    await runSelfCheck();
    return;
  }

  const inputPath = getArg('--input');
  if (!inputPath) {
    console.error('--input <パス> が必要です（例: state/expansion/expansion-drafts.json）。');
    process.exitCode = 1;
    return;
  }
  const priorPath = getArg('--prior');
  const charFilter = getArg('--char');
  const force = args.includes('--force');

  const dataDir = new URL('../../data/', import.meta.url);
  const stateDir = fileURLToPath(new URL('../../state/', import.meta.url));
  const samplesDir = join(stateDir, 'expansion', 'samples');
  const wikiCacheDir = join(stateDir, 'expansion', 'wiki');
  const evidenceDir = join(stateDir, 'expansion', 'evidence');
  const danbooruCacheDir = join(stateDir, 'bayes-pipeline', 'danbooru');
  const niconicoCacheDir = join(stateDir, 'bayes-pipeline', 'niconico');
  const llmCacheDir = join(stateDir, 'bayes-pipeline', 'llm');

  const characters = JSON.parse(readFileSync(fileURLToPath(new URL('characters.json', dataDir)), 'utf8'));
  const niconicoMap = JSON.parse(readFileSync(fileURLToPath(new URL('bayes/niconico-map.json', dataDir)), 'utf8'));
  const llmExtract = JSON.parse(readFileSync(fileURLToPath(new URL('bayes/llm-extract.json', dataDir)), 'utf8'));

  const drafts = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
  const priorList = priorPath ? loadJsonOrNull(resolve(priorPath)) : null;
  if (priorPath && priorList === null) {
    console.error(`[警告] --prior「${priorPath}」が読めません。priorEvidenceは全件空になります。`);
  }
  const priorIndex = buildPriorIndex(priorList ?? []);

  const reviewedCharacters = characters.filter((c) => c.reviewed === true);
  const seriesConventionMap = buildSeriesConventionMap(reviewedCharacters);

  mkdirSync(wikiCacheDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });

  const targets = charFilter ? drafts.filter((d) => d.id === charFilter) : drafts;
  if (charFilter && targets.length === 0) {
    console.error(`指定されたキャラid「${charFilter}」が --input に見つかりません。`);
    process.exitCode = 1;
    return;
  }
  console.log(`根拠の束の作成対象 ${targets.length} 件`);

  const danbooruFetch = createDanbooruFetcher({});

  let written = 0;
  let niconicoCount = 0;
  let llmCount = 0;
  let priorCount = 0;
  let wikiCount = 0;
  let hairColorNull = 0;
  let bustNull = 0;
  let noPosts = 0;
  const wikiFailures = [];

  for (const [index, draft] of targets.entries()) {
    process.stdout.write(`[${index + 1}/${targets.length}] ${draft.name} (${draft.id}) ... `);

    const posts = loadPosts(samplesDir, danbooruCacheDir, draft.id, draft.danbooruTag);
    if (posts.length === 0) noPosts += 1;
    const { P, soloUsed } = selectP(posts);
    const ctx = buildContext(P);
    const { measured, measuredShares } = computeMeasured(ctx);
    if (measured.hairColor === null) hairColorNull += 1;
    if (measured.bust === null) bustNull += 1;

    const hints = {
      tagFreq: computeTagFreq(ctx),
      speciesSuggestion: computeSpeciesSuggestion(ctx),
      topTags: computeTopTags(ctx),
      calibration: CALIBRATION_NOTE,
    };

    const seriesConvention = seriesConventionMap.get(draft.series) ?? emptySeriesConvention();

    const niconicoTitle = niconicoMap.entries[draft.id]?.title ?? null;
    const niconicoText = loadNiconicoText(draft.id, niconicoTitle, niconicoCacheDir);
    if (niconicoText !== null) niconicoCount += 1;

    const llmEntry = llmExtract.entries[draft.id];
    const llmState = loadJsonOrNull(join(llmCacheDir, `${draft.id}.json`));
    const llmEvidence = buildLlmEvidence(llmEntry, llmState);
    if (llmEvidence.length > 0) llmCount += 1;

    const priorEvidence = selectPriorEvidence(priorIndex, draft.danbooruTag);
    if (priorEvidence.length > 0) priorCount += 1;

    const wikiResult = await getWikiBody(danbooruFetch, draft.danbooruTag, wikiCacheDir, { force });
    if (wikiResult.failed) {
      wikiFailures.push({ id: draft.id, name: draft.name, tag: draft.danbooruTag, error: wikiResult.error });
    }
    const danbooruWiki = wikiResult.body !== null ? wikiResult.body.slice(0, DANBOORU_WIKI_TEXT_LIMIT) : null;
    if (danbooruWiki !== null) wikiCount += 1;

    const record = {
      id: draft.id,
      name: draft.name,
      series: draft.series,
      danbooruTag: draft.danbooruTag,
      postsUsed: P.length,
      soloUsed,
      measured,
      measuredShares,
      hints,
      seriesConvention,
      text: { niconicoTitle, niconico: niconicoText, llm: llmEvidence, priorEvidence, danbooruWiki },
    };
    writeFileSync(join(evidenceDir, `${draft.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    written += 1;

    console.log(
      `完了 (posts=${P.length}${soloUsed ? '/solo' : ''}, wiki=${wikiResult.failed ? '失敗' : danbooruWiki !== null ? 'あり' : 'なし'})`,
    );
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    totalInput: targets.length,
    written,
    niconicoAvailable: niconicoCount,
    llmEvidenceAvailable: llmCount,
    priorEvidenceAvailable: priorCount,
    wikiAvailable: wikiCount,
    hairColorNull,
    bustNull,
    noPosts,
    wikiFetchFailed: wikiFailures.length,
  };
  writeFileSync(join(evidenceDir, '_index.json'), `${JSON.stringify({ ...summary, wikiFailures }, null, 2)}\n`);

  console.log('\n=== 完了 ===');
  console.log(`書き出し: ${written} / ${targets.length} 件 → ${evidenceDir}`);
  console.log(`ニコニコ本文あり: ${niconicoCount} 件`);
  console.log(`LLM引用あり: ${llmCount} 件`);
  console.log(`prior引用あり: ${priorCount} 件`);
  console.log(`Danbooru wikiあり: ${wikiCount} 件`);
  console.log(`hairColor null: ${hairColorNull} 件 / bust null: ${bustNull} 件`);
  console.log(`投稿データなし: ${noPosts} 件`);
  if (wikiFailures.length > 0) {
    console.log(`\n=== wiki取得失敗（${WIKI_MAX_RETRIES}回再試行後も失敗） ${wikiFailures.length} 件 ===`);
    for (const f of wikiFailures) console.log(`  ${f.id} (${f.name}, ${f.tag}): ${f.error}`);
    console.log('\n同じコマンドを再実行すると、取得済みキャッシュはスキップしてこれらだけ再取得します。');
  }
}

// ---- 自己点検（--self-check） ----

/**
 * measured の計算規則を既存の査読済みキャラにかけ、査読済みの値との一致率を出す。
 * hairColorは「最上位の色が査読済み配列に入っている率」、bust/skinToneは値の一致率、
 * looksは「長髪」「ケモミミ」それぞれの有無一致率（どちらも持つ/どちらも持たないを一致とする）。
 */
async function runSelfCheck() {
  const dataDir = new URL('../../data/', import.meta.url);
  const danbooruCacheDir = fileURLToPath(new URL('../../state/bayes-pipeline/danbooru/', import.meta.url));
  const characters = JSON.parse(readFileSync(fileURLToPath(new URL('characters.json', dataDir)), 'utf8'));
  const reviewed = characters.filter((c) => c.reviewed === true);

  let noCache = 0;
  const tally = {
    hairColor: { total: 0, match: 0 },
    bust: { total: 0, match: 0 },
    skinTone: { total: 0, match: 0 },
    looksLongHair: { total: 0, match: 0 },
    looksAnimalEars: { total: 0, match: 0 },
  };

  for (const c of reviewed) {
    const cached = loadJsonOrNull(join(danbooruCacheDir, `${c.id}.json`));
    if (!Array.isArray(cached?.posts) || cached.posts.length === 0) {
      noCache += 1;
      continue;
    }
    const { P } = selectP(cached.posts);
    const ctx = buildContext(P);
    const { raw } = computeMeasured(ctx);

    if (raw.hair.top !== null && Array.isArray(c.axes?.hairColor) && c.axes.hairColor.length > 0) {
      tally.hairColor.total += 1;
      if (c.axes.hairColor.includes(raw.hair.top)) tally.hairColor.match += 1;
    }
    if (raw.bust.value !== null && c.axes?.bust != null) {
      tally.bust.total += 1;
      if (raw.bust.value === c.axes.bust) tally.bust.match += 1;
    }
    if (c.axes?.skinTone != null) {
      tally.skinTone.total += 1;
      if (raw.skin.value === c.axes.skinTone) tally.skinTone.match += 1;
    }
    const reviewedLooks = new Set(c.axes?.looks ?? []);
    tally.looksLongHair.total += 1;
    if (raw.looks.value.includes('長髪') === reviewedLooks.has('長髪')) tally.looksLongHair.match += 1;
    tally.looksAnimalEars.total += 1;
    if (raw.looks.value.includes('ケモミミ') === reviewedLooks.has('ケモミミ')) tally.looksAnimalEars.match += 1;
  }

  const report = { generatedAt: new Date().toISOString(), reviewedTotal: reviewed.length, noCache };
  for (const key of Object.keys(tally)) {
    const { total, match } = tally[key];
    report[key] = { total, match, rate: total > 0 ? round3(match / total) : null };
  }

  const evidenceDir = fileURLToPath(new URL('../../state/expansion/evidence/', import.meta.url));
  mkdirSync(evidenceDir, { recursive: true });
  const outPath = join(evidenceDir, '_self-check.json');
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log('=== 自己点検（measuredの計算規則 × 既存査読済みキャラ） ===');
  console.log(`査読済み${reviewed.length}体中、Danbooruキャッシュあり${reviewed.length - noCache}体（キャッシュなし${noCache}体は対象外）`);
  for (const key of Object.keys(tally)) {
    const { total, match, rate } = report[key];
    console.log(`  ${key}: ${match}/${total} (${rate === null ? 'N/A' : `${(rate * 100).toFixed(1)}%`})`);
  }
  console.log(`\n詳細: ${outPath}`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
