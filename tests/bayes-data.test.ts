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

/**
 * wikidata の axis は schema.ts の Axes キーに縛られない独自集合（eyeColor は
 * Axesに存在しない事実キー）。llm の axis は抽出対象＝16軸マップのaxis-only質問
 * （personality/mood/roles/species/combat/affiliationKind/distance）に限る
 * （PLAN「P5」）。
 */
const WIKIDATA_AXIS_KEYS = ['genderExpression', 'hairColor', 'eyeColor', 'species', 'stature'] as const;
const LLM_AXIS_KEYS = [
  'personality', 'mood', 'species', 'combat', 'distance', 'affiliationKind', 'roles',
  'ageFeel', 'build', 'stature', 'occupation',
] as const;

const sourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('danbooru-group'), group: z.string().min(1), tag: z.string().min(1) }),
  z.object({ type: z.literal('danbooru-binary'), tag: z.string().min(1) }),
  z.object({ type: z.literal('axis'), axis: z.string().min(1), value: z.string().min(1), multi: z.boolean() }),
  z.object({ type: z.literal('wikidata'), axis: z.enum(WIKIDATA_AXIS_KEYS), value: z.string().min(1), multi: z.boolean() }),
  z.object({ type: z.literal('llm'), axis: z.enum(LLM_AXIS_KEYS), value: z.string().min(1), multi: z.boolean() }),
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
  'affiliationKind', 'affiliationName', 'stature', 'occupation',
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
  type TagMapEntry = {
    tag: string | null;
    reason?: string;
    source?: string;
    seriesOverlap?: number | null;
  };
  const tagMap = JSON.parse(readFileSync(new URL('../data/bayes/tag-map.json', import.meta.url), 'utf8')) as {
    entries: Record<string, TagMapEntry>;
  };
  const overridesFile = JSON.parse(
    readFileSync(new URL('../data/bayes/tag-overrides.json', import.meta.url), 'utf8'),
  ) as {
    seriesAliases: Record<string, string>;
    overrides: Record<string, { tag: string | null; reason?: string }>;
  };

  /**
   * scripts/bayes/map-characters.mjs の SERIES_OVERLAP_MIN と意図的に二重化する。
   * ACCEPTANCE A5 と同じ考え方で、片方だけ変えたらここで落ちるのが検出力そのもの。
   */
  const SERIES_OVERLAP_MIN = 0.3;

  it('tag-map.json は全キャラを1件ずつ持ち、tag=nullは reason 必須', () => {
    const ids = new Set(charactersFile.map((c) => c.id));
    expect(new Set(Object.keys(tagMap.entries))).toEqual(ids);
    for (const [id, entry] of Object.entries(tagMap.entries)) {
      if (entry.tag === null) expect(entry.reason, id).toBeTruthy();
    }
  });

  /**
   * 実際に起きた事故（2026-08-01）の再発防止。
   *
   * キャラ拡充で新しい作品を足したとき seriesAliases への追加を忘れると、
   * map-characters.mjs の seriesOverlapRatio() が `if (!seriesAlias) return null` で
   * 黙って検証をスキップし、ワイルドカードの誤ヒットがそのまま採用される。
   * 実際に 符玄→fujiwara_no_mokou（東方）、SAOアスナ→asuna_(blue_archive) など
   * 5件が誤対応のまま出荷され、ポートフォリオサイト側で別キャラの画像が表示された。
   *
   * 「エイリアスを足し忘れない」を人間の記憶に頼らず、ここで機械的に止める。
   */
  it('characters.json の全作品が seriesAliases に定義されている', () => {
    const seriesList = [...new Set(charactersFile.map((c) => c.series))].sort();
    const missing = seriesList.filter((s) => !(s in overridesFile.seriesAliases));
    expect(
      missing,
      `seriesAliases 未定義の作品があります: ${missing.join(' / ')}\n` +
        '→ data/bayes/tag-overrides.json の seriesAliases に Danbooru の category=3(著作権)タグを\n' +
        '   追加してから scripts/bayes/map-characters.mjs を実行すること。\n' +
        '   未定義のままだと作品タグとの共起検証がスキップされ、誤タグが素通りする。',
    ).toEqual([]);
  });

  /**
   * 上と対になる出口側のゲート。原因が何であれ「検証されていないタグ」を出荷させない。
   * 手動 override は人間が確認済みなので理由付きで許可する。
   */
  it('tag が non-null のエントリは共起検証済みか、理由付きの override であること', () => {
    const unverified = Object.entries(tagMap.entries)
      .filter(([, e]) => e.tag !== null)
      .filter(([, e]) => e.source !== 'override')
      .filter(([, e]) => typeof e.seriesOverlap !== 'number' || e.seriesOverlap < SERIES_OVERLAP_MIN);
    expect(
      unverified.map(([id, e]) => `${id}(${e.tag}, source=${e.source}, overlap=${e.seriesOverlap})`),
      '作品タグとの共起検証を通っていないタグがあります。\n' +
        `→ 共起率が ${SERIES_OVERLAP_MIN} 未満か未計測です。別作品の同名キャラを掴んでいる可能性が高い。\n` +
        '   正しいタグを tag-overrides.json の overrides に理由付きで指定するか、\n' +
        '   seriesAliases を直してから map-characters.mjs を再実行すること。',
    ).toEqual([]);
  });

  it('override は必ず理由を持つ（後から根拠を辿れるようにする）', () => {
    const noReason = Object.entries(overridesFile.overrides)
      .filter(([, v]) => !v.reason?.trim())
      .map(([id]) => id);
    expect(noReason, `理由の無い override: ${noReason.join(', ')}`).toEqual([]);
  });

  /**
   * 同じキャラの重複登録の再発防止（2026-10-04 発見）。
   *
   * 初期データの fate-jeanne と、500体拡張で足した fgo-jeanne が同じキャラ（ジャンヌ・ダルク、
   * Fate/Grand Order）だった。しかも fate-jeanne は名前のワイルドカード検索で件数が最多の
   * jeanne_d'arc_alter_(fate)（ジャンヌ・オルタ）を掴んでおり、fate-jalter と同じタグに
   * なっていた。同じキャラが2体いると推定で区別できず、片方には別キャラの絵の統計が付く。
   * 表示名+作品名の一致と、Danbooru タグの一致の両方で止める。
   */
  it('同じキャラを重複して登録していない（表示名+作品名も、Danbooru タグも重ならない）', () => {
    const byNameSeries = new Map<string, string[]>();
    for (const c of charactersFile) {
      const key = `${c.name} / ${c.series}`;
      byNameSeries.set(key, [...(byNameSeries.get(key) ?? []), c.id]);
    }
    const dupNames = [...byNameSeries.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([key, ids]) => `${key}: ${ids.join(', ')}`);

    const byTag = new Map<string, string[]>();
    for (const [id, entry] of Object.entries(tagMap.entries)) {
      if (entry.tag === null) continue;
      byTag.set(entry.tag, [...(byTag.get(entry.tag) ?? []), id]);
    }
    const dupTags = [...byTag.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([tag, ids]) => `${tag}: ${ids.join(', ')}`);

    expect(dupNames, '表示名と作品名が同じキャラが複数います（重複登録の疑い）').toEqual([]);
    expect(
      dupTags,
      '同じ Danbooru タグに解決されたキャラが複数います。\n' +
        '→ 別キャラのタグを掴んでいるか、同じキャラの重複登録です。',
    ).toEqual([]);
  });
});

describe('BA7. wikidata-map.json / wikidata-facts.json の整合性（PLAN「P5a」）', () => {
  const wikidataMap = JSON.parse(readFileSync(new URL('../data/bayes/wikidata-map.json', import.meta.url), 'utf8'));
  const wikidataFacts = JSON.parse(readFileSync(new URL('../data/bayes/wikidata-facts.json', import.meta.url), 'utf8'));
  const GENDER_VALUES = new Set(['女性', 'おとこの娘', 'ふたなり', '男性']);
  const HAIR_COLOR_VALUES = new Set(['黒', '白', '金', '茶', '赤', '青', '緑', '桃', '紫', '銀', '橙']);
  const EYE_COLOR_TOKENS = new Set(['aqua', 'black', 'blue', 'brown', 'green', 'grey', 'orange', 'purple', 'red', 'yellow']);
  const STATURE_VALUES = new Set(['小柄', '標準', '長身']);

  it('wikidata-map.json は全キャラを1件ずつ持ち、qid=nullは reason 必須', () => {
    const ids = new Set(charactersFile.map((c) => c.id));
    expect(new Set(Object.keys(wikidataMap.entries))).toEqual(ids);
    for (const [id, entry] of Object.entries(wikidataMap.entries) as [string, { qid: string | null; reason?: string }][]) {
      if (entry.qid === null) expect(entry.reason, id).toBeTruthy();
    }
  });

  it('wikidata-facts.json は全キャラを1件ずつ持つ（空オブジェクトも可）', () => {
    const ids = new Set(charactersFile.map((c) => c.id));
    expect(new Set(Object.keys(wikidataFacts.entries))).toEqual(ids);
  });

  it('facts の各値は既知の値域に収まる', () => {
    for (const [id, facts] of Object.entries(wikidataFacts.entries) as [string, Record<string, unknown>][]) {
      if ('genderExpression' in facts) expect(GENDER_VALUES.has(facts.genderExpression as string), id).toBe(true);
      if ('hairColor' in facts) expect(HAIR_COLOR_VALUES.has(facts.hairColor as string), id).toBe(true);
      if ('eyeColor' in facts) expect(EYE_COLOR_TOKENS.has(facts.eyeColor as string), id).toBe(true);
      if ('stature' in facts) expect(STATURE_VALUES.has(facts.stature as string), id).toBe(true);
      if ('species' in facts) {
        expect(Array.isArray(facts.species), id).toBe(true);
        expect((facts.species as string[]).every((v) => v === '人間'), id).toBe(true);
      }
    }
  });

  it('facts.genderExpression は本プロジェクト自身の査読済みcharacters.jsonと食い違わない（サニティチェックの回帰防止）', () => {
    // 2026-07-25、azurlane-nagatoがWikidata誤対応でgenderExpression=男性を返した
    // 実例で発覚。map-wikidata.mjs側でこの食い違いを検出したキャラのfactsは
    // 丸ごと{}に無効化される設計なので、ここでその契約が守られているか検証する。
    const byId = new Map(charactersFile.map((c) => [c.id, c]));
    for (const [id, facts] of Object.entries(wikidataFacts.entries) as [string, { genderExpression?: string }][]) {
      if (!facts.genderExpression) continue;
      const reviewed = byId.get(id)?.axes.genderExpression;
      expect(facts.genderExpression, `${id}: wikidata=${facts.genderExpression} vs 査読済み=${reviewed}`).toBe(reviewed);
    }
  });
});

describe('BA8. niconico-map.json / llm-extract.json の整合性（PLAN「P5b」）', () => {
  const niconicoMap = JSON.parse(readFileSync(new URL('../data/bayes/niconico-map.json', import.meta.url), 'utf8'));
  const llmExtractRaw = JSON.parse(readFileSync(new URL('../data/bayes/llm-extract.json', import.meta.url), 'utf8'));
  const SINGLE_VALUE_AXES = ['personality', 'mood', 'species', 'combat', 'distance', 'affiliationKind'];
  const CONFIDENCE_VALUES = new Set(['high', 'low', 'none']);

  it('niconico-map.json は全キャラを1件ずつ持ち、title=nullは reason 必須', () => {
    const ids = new Set(charactersFile.map((c) => c.id));
    expect(new Set(Object.keys(niconicoMap.entries))).toEqual(ids);
    for (const [id, entry] of Object.entries(niconicoMap.entries) as [string, { title: string | null; reason?: string }][]) {
      if (entry.title === null) expect(entry.reason, id).toBeTruthy();
    }
  });

  it('niconico-map.json は記事本文(プロース)を持たない（gitignoreの state/bayes-pipeline/niconico/ にのみ存在する契約）', () => {
    expect(JSON.stringify(niconicoMap).includes('"text"')).toBe(false);
  });

  it('llm-extract.json の各エントリは axes を持ち、単一値軸は{value,verified,confidence}・rolesは{values,verified,confidence}の形', () => {
    type AxisResult = { value?: string; values?: string[]; verified: boolean; confidence: string };
    for (const [id, entry] of Object.entries(llmExtractRaw.entries) as [string, { article: string; axes: Record<string, AxisResult> }][]) {
      expect(entry.article, id).toBeTruthy();
      for (const axis of SINGLE_VALUE_AXES) {
        const a = entry.axes[axis];
        expect(a, `${id}.${axis}`).toBeDefined();
        expect(typeof a.value, `${id}.${axis}.value`).toBe('string');
        expect(typeof a.verified, `${id}.${axis}.verified`).toBe('boolean');
        expect(CONFIDENCE_VALUES.has(a.confidence), `${id}.${axis}.confidence`).toBe(true);
      }
      const roles = entry.axes.roles;
      expect(Array.isArray(roles.values), `${id}.roles.values`).toBe(true);
      expect(typeof roles.verified, `${id}.roles.verified`).toBe('boolean');
      expect(CONFIDENCE_VALUES.has(roles.confidence), `${id}.roles.confidence`).toBe(true);
    }
  });

  it('llm-extract.json は生の引用文・生応答を持たない（gitignoreの state/bayes-pipeline/llm/ にのみ存在する契約。プロース非混入の担保）', () => {
    const raw = JSON.stringify(llmExtractRaw);
    expect(raw.includes('"quote"')).toBe(false);
    expect(raw.includes('"rawResponse"')).toBe(false);
  });

  it('niconico-map.json / llm-extract.json は禁止語(config/forbidden-terms.json)を含まない', () => {
    const hits: string[] = [];
    const targets: [string, string][] = [
      ['niconico-map.json', JSON.stringify(niconicoMap)],
      ['llm-extract.json', JSON.stringify(llmExtractRaw)],
    ];
    for (const [name, raw] of targets) {
      const lower = raw.toLowerCase();
      for (const term of FORBIDDEN_TERMS) {
        if (lower.includes(term.toLowerCase())) hits.push(`${name}: 「${term}」を含む`);
      }
    }
    expect(hits).toEqual([]);
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
