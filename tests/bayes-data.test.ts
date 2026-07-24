import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import forbiddenTermsFile from '../config/forbidden-terms.json';
import charactersFile from '../data/characters.json';
import likelihoodsFile from '../data/bayes/likelihoods.json';
import questionsFile from '../data/bayes/questions.json';
import questionsRuntimeFile from '../data/bayes/questions.runtime.json';

/**
 * BA系(data/bayes/*.json)の構造・確率範囲・射影ドリフト・禁止語照合。
 * data/はESLint(禁止語lint含む)の対象外なので、BA4がこのファイル群での
 * 唯一の機械的な禁止語ゲートになる（PLAN「トーン・lint対策」）。
 */

const FORBIDDEN_TERMS: string[] = forbiddenTermsFile.terms;

const sourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('danbooru-group'), group: z.string().min(1), tag: z.string().min(1) }),
  z.object({ type: z.literal('danbooru-binary'), tag: z.string().min(1) }),
  z.object({ type: z.literal('axis'), axis: z.string().min(1), value: z.string().min(1), multi: z.boolean() }),
  z.object({ type: z.literal('llm') }).passthrough(),
]);

const questionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  reason: z.object({ axis: z.string().min(1), label: z.string().min(1), value: z.string().min(1) }),
  sources: z.array(sourceSchema).min(1),
});

const questionsSchema = z.object({
  version: z.number().int().positive(),
  groups: z.record(z.string(), z.object({ coverageTags: z.array(z.string().min(1)).min(1) })),
  questions: z.array(questionSchema),
});

const likelihoodsSchema = z.object({
  epsilon: z.number().positive().lt(0.5),
  questionIds: z.array(z.string().min(1)),
  baseRates: z.array(z.number()),
  chars: z.record(z.string(), z.array(z.number())),
});

const runtimeSchema = z.object({
  version: z.number().int().positive(),
  questions: z.array(
    z.object({
      key: z.string().min(1),
      prompt: z.string().min(1),
      reason: z.object({ axis: z.string().min(1), label: z.string().min(1), value: z.string().min(1) }),
    }),
  ),
});

/** schema.ts の Axes 実キーと一致させる（typoの早期検出。tests/data.test.ts のA5相当）。 */
const VALID_AXIS_KEYS = new Set([
  'genderExpression', 'ageFeel', 'build', 'bust', 'personality', 'roles', 'distance',
  'looks', 'hairColor', 'skinTone', 'outfit', 'species', 'mood', 'combat',
  'affiliationKind', 'affiliationName',
]);

describe('BA1. questions.json の構造', () => {
  it('スキーマに適合する', () => {
    const result = questionsSchema.safeParse(questionsFile);
    expect(result.success, JSON.stringify(result.success ? null : result.error?.issues, null, 2)).toBe(true);
  });

  // 生JSONのimport型はunion推論が narrow しにくいため、以降はparse済みの型付きオブジェクトを使う
  // （tests/data.test.ts と同じ「先にsafeParseで検証、以降はparse結果を使う」方針）。
  const typedQuestions = questionsSchema.parse(questionsFile);

  it('質問idが重複しない', () => {
    const ids = typedQuestions.questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('danbooru-groupソースが参照するgroup/tagは groups に実在する', () => {
    for (const q of typedQuestions.questions) {
      for (const s of q.sources) {
        if (s.type !== 'danbooru-group') continue;
        expect(typedQuestions.groups[s.group], `${q.id}: group「${s.group}」が groups に無い`).toBeDefined();
        expect(typedQuestions.groups[s.group].coverageTags, `${q.id}: tag「${s.tag}」が coverageTags に無い`).toContain(s.tag);
      }
    }
  });

  it('axisソースの axis は schema.ts の Axes キーと一致する（typo検出）', () => {
    for (const q of typedQuestions.questions) {
      for (const s of q.sources) {
        if (s.type !== 'axis') continue;
        expect(VALID_AXIS_KEYS.has(s.axis), `${q.id}: axis「${s.axis}」が不正`).toBe(true);
      }
    }
    for (const q of typedQuestions.questions) {
      expect(VALID_AXIS_KEYS.has(q.reason.axis), `${q.id}: reason.axis「${q.reason.axis}」が不正`).toBe(true);
    }
  });

  it('reason.axis+valueの組が質問間で重複しない（bayes.tsの根拠→尤度逆引きが一意であるための前提）', () => {
    const seen = new Map<string, string>();
    for (const q of typedQuestions.questions) {
      const k = `${q.reason.axis}::${q.reason.value}`;
      expect(seen.has(k), `${q.id} と ${seen.get(k)} が reason(${k}) で衝突`).toBe(false);
      seen.set(k, q.id);
    }
  });

  it('BA4: prompt・reason.label・reason.value が禁止語(config/forbidden-terms.json)を含まない', () => {
    const hits: string[] = [];
    for (const q of typedQuestions.questions) {
      const text = `${q.prompt} ${q.reason.label} ${q.reason.value}`.toLowerCase();
      for (const term of FORBIDDEN_TERMS) {
        if (text.includes(term.toLowerCase())) hits.push(`${q.id}: 「${term}」を含む(${text})`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe('BA2. likelihoods.json の構造・確率範囲', () => {
  it('スキーマに適合する', () => {
    const result = likelihoodsSchema.safeParse(likelihoodsFile);
    expect(result.success, JSON.stringify(result.success ? null : result.error?.issues, null, 2)).toBe(true);
  });

  it('questionIds は questions.json と同数・重複なしの不透明キー集合', () => {
    // BA3の通り、questionIdsはquestions.jsonのid（Danbooruタグ名を含む）とは
    // 意図的に別の不透明キーなので、ここでは文字列集合の一致ではなく
    // 「同数・重複なし」だけを見る（内容の対応はBA3が担当）。
    expect(likelihoodsFile.questionIds.length).toBe(questionsFile.questions.length);
    expect(new Set(likelihoodsFile.questionIds).size).toBe(likelihoodsFile.questionIds.length);
  });

  it('全キャラが characters.json と同じ id 集合で存在する', () => {
    const fromCharacters = new Set(charactersFile.map((c) => c.id));
    const fromLikelihoods = new Set(Object.keys(likelihoodsFile.chars));
    expect(fromLikelihoods).toEqual(fromCharacters);
  });

  it('全キャラの尤度配列長が questionIds の長さと一致する', () => {
    for (const [id, arr] of Object.entries(likelihoodsFile.chars)) {
      expect(arr.length, `${id}`).toBe(likelihoodsFile.questionIds.length);
    }
  });

  it('全ての確率値が [epsilon, 1-epsilon] の範囲内でNaNでない', () => {
    const { epsilon } = likelihoodsFile;
    for (const [id, arr] of Object.entries(likelihoodsFile.chars)) {
      for (const [i, p] of arr.entries()) {
        expect(Number.isNaN(p), `${id}[${i}]=${p}`).toBe(false);
        expect(p, `${id}[${i}]`).toBeGreaterThanOrEqual(epsilon);
        expect(p, `${id}[${i}]`).toBeLessThanOrEqual(1 - epsilon);
      }
    }
  });

  it('baseRates も [epsilon, 1-epsilon] の範囲内（軸のみソースの質問は0.5になり得る）', () => {
    const { epsilon } = likelihoodsFile;
    for (const [i, b] of likelihoodsFile.baseRates.entries()) {
      expect(b, `baseRates[${i}]`).toBeGreaterThanOrEqual(epsilon);
      expect(b, `baseRates[${i}]`).toBeLessThanOrEqual(1 - epsilon);
    }
  });
});

describe('BA3. questions.runtime.json の射影ドリフト検出', () => {
  it('スキーマに適合する', () => {
    const result = runtimeSchema.safeParse(questionsRuntimeFile);
    expect(result.success, JSON.stringify(result.success ? null : result.error?.issues, null, 2)).toBe(true);
  });

  it('questions.json と同じ並び順で1:1対応し、prompt/reasonが完全一致する', () => {
    // 実行時keyは意図的に questions.json の id（dg:hair-color:black_hair 等、
    // Danbooruタグ名を生で含む）とは別の不透明な連番にしてある（下のテスト参照）。
    // そのため対応はキー文字列ではなく配列位置（build-likelihoods.mjsが同じ順で
    // 生成する）で取る。
    expect(questionsRuntimeFile.questions.length).toBe(questionsFile.questions.length);
    questionsFile.questions.forEach((q, i) => {
      const runtime = questionsRuntimeFile.questions[i];
      expect(runtime.prompt, `[${i}] ${q.id}`).toBe(q.prompt);
      expect(runtime.reason, `[${i}] ${q.id}`).toEqual(q.reason);
    });
  });

  it('実行時keyはquestions.jsonのid（Danbooruタグ名を含む）を再利用しない不透明な識別子', () => {
    // 2026-07-24、`likelihoods.json`の`questionIds`をquestions.jsonの`id`と
    // 同一にしていたため、"dg:hair-color:black_hair"等のDanbooruタグ名が
    // 生の文字列としてdistバンドルへ丸ごと混入していた実バグの再発防止
    // （`grep dist/assets/*.js`で実機確認）。
    const sourceIds = new Set(questionsFile.questions.map((q) => q.id));
    for (const key of likelihoodsFile.questionIds) {
      expect(sourceIds.has(key), `questionIds「${key}」がquestions.jsonのidをそのまま使っている`).toBe(false);
      expect(key, key).toMatch(/^q\d+$/);
    }
    for (const q of questionsRuntimeFile.questions) {
      expect(sourceIds.has(q.key), `runtime key「${q.key}」がquestions.jsonのidをそのまま使っている`).toBe(false);
    }
  });

  it('sources フィールド・生のDanbooruタグ文字列を一切含まない', () => {
    const raw = JSON.stringify(questionsRuntimeFile);
    expect(raw.includes('"sources"')).toBe(false);
    const allTags = new Set(
      questionsFile.questions.flatMap((q) =>
        q.sources.flatMap((s) => ('tag' in s && typeof s.tag === 'string' ? [s.tag] : [])),
      ),
    );
    for (const tag of allTags) {
      // 完全一致(quoted value)だけでなく部分文字列としての混入も見る
      // （2026-07-24、key: q.id の実装が"db:thighhighs"のような複合文字列で
      // 混入していたのに完全一致判定では検出できなかった実例を踏まえる）。
      expect(raw.includes(tag), `タグ文字列「${tag}」がruntimeに漏れている（部分一致含む）`).toBe(false);
    }
  });
});

describe('BA5. tag-overrides.json / tag-map.json の整合性', () => {
  it('tag-map.json は全キャラを1件ずつ持ち、tag=nullは reason 必須', () => {
    const tagMap = JSON.parse(readFileSync(new URL('../data/bayes/tag-map.json', import.meta.url), 'utf8'));
    const ids = new Set(charactersFile.map((c) => c.id));
    expect(new Set(Object.keys(tagMap.entries))).toEqual(ids);
    for (const [id, entry] of Object.entries(tagMap.entries) as [string, { tag: string | null; reason?: string }][]) {
      if (entry.tag === null) expect(entry.reason, id).toBeTruthy();
    }
  });
});

/**
 * questions.json の（Danbooruタグ名を含む）記述的idから、実行時の不透明key配列上の
 * 位置を引く。likelihoods.json/questions.runtime.json のkeyはid自体とは別物
 * （上のBA3参照）なので、questions.jsonの並び順（=build-likelihoods.mjsの反復順）
 * を介して対応させる。
 */
function likelihoodIndexOf(sourceId: string): number {
  const idx = questionsFile.questions.findIndex((q) => q.id === sourceId);
  if (idx === -1) throw new Error(`likelihoodIndexOf: questions.jsonに「${sourceId}」が無い`);
  return idx;
}

describe('BA6. likelihoods.json の既知実測値との整合（ビルドパイプライン全体のオラクル）', () => {
  it('紅美鈴: red_hairの尤度がgreen_hairより明確に高い（Web検証済み実測: 15,378件 vs 1,402件）', () => {
    const redIdx = likelihoodIndexOf('dg:hair-color:red_hair');
    const greenIdx = likelihoodIndexOf('dg:hair-color:green_hair');
    const p = likelihoodsFile.chars['touhou-meiling'];
    expect(p[redIdx]).toBeGreaterThan(0.5);
    expect(p[greenIdx]).toBeLessThan(0.3);
    expect(p[redIdx]).toBeGreaterThan(p[greenIdx]);
  });

  it('Danbooruタグを持たないキャラ(azurlane-yamato)は軸ソースのみで妥当な値になる', () => {
    const combatIdx = likelihoodIndexOf('ax:combat=戦う');
    // 実データのcombat軸値が「戦う」の場合、danbooru重み0でaxisのみに従いAXIS_SINGLE_MATCH(0.9)相当になるはず。
    const yamato = charactersFile.find((c) => c.id === 'azurlane-yamato')!;
    if (yamato.axes.combat === '戦う') {
      expect(likelihoodsFile.chars['azurlane-yamato'][combatIdx]).toBeCloseTo(0.9, 2);
    }
  });
});
