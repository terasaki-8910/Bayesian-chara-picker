#!/usr/bin/env node
/**
 * state/bayes-pipeline/niconico/<id>.json にキャッシュ済みの記事本文から、
 * ローカルLLM(qwen3:8b・Ollama)でaxis-only 38問（personality/mood/species/
 * combat/distance/affiliationKind/roles）の値をevidence-first方式で抽出し、
 * data/bayes/llm-extract.json（制御語彙のみ・引用文は持たない）へ書き出す
 * （PLAN「P5b」）。生プロンプト・生応答・引用文の全証跡は
 * state/bayes-pipeline/llm/<id>.json にのみ残す（gitignore、監査用）。
 *
 * evidence-first抽出（scripts/bayes/ollama-client.mjsの実地検証で必要性を実証済み）:
 *   1. 各軸についてquoteを先に書かせ、valueはそのquoteだけを根拠に判定させる
 *      （スキーマでquoteをvalueより前の必須フィールドにする）。
 *   2. 決定論だけでquoteが原文に実在するかを照合する（LLMを信用しない）。
 *      実在しなければ幻覚とみなしvalueも不採用（MAX_LLM_RETRIESまで再プロンプト）。
 *   3. 該当なし/confidence!=='high' は無情報として扱い、マージにnullで寄与する
 *      （estimateLlmLikelihoodがverified!==true・confidence!=='high'を弾く）。
 *
 * 抽出は温度0・固定seedで決定論的なので、同じ記事本文・同じプロンプト/スキーマ
 * である限り再実行しても同じ結果になる。map-wikidata.mjs等の「7日で失効」という
 * 時間ベースのキャッシュとは異なり、「既存エントリがあればスキップ」という
 * シンプルな戦略にする（--force で無視、--char <id> で単体のみ強制再実行）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWhitespace } from './niconico-client.mjs';
import { createOllamaClient } from './ollama-client.mjs';

const MODEL = 'qwen3:8b';
/** 抽出プロンプト/スキーマのバージョンを日付で示す固定シード（temp:0と併用し決定論を担保）。 */
const SEED = 20260725;
/** 1文字引用等の自明一致を弾く最低長ガード。 */
const MIN_QUOTE_LENGTH = 6;
/** 幻覚引用1回だけでは切り捨てず、軸ごとに最大2回まで再プロンプトする。 */
const MAX_LLM_RETRIES = 2;

const LLM_AXIS_KEYS = ['personality', 'mood', 'species', 'combat', 'distance', 'affiliationKind', 'roles'];
const SINGLE_VALUE_AXES = LLM_AXIS_KEYS.filter((k) => k !== 'roles');

const AXIS_LABELS = {
  personality: '性格',
  mood: '関係性の空気感',
  species: '種族',
  combat: '戦闘の有無',
  distance: '距離感・積極性',
  affiliationKind: '所属の種類',
  roles: '関係性の役割（複数可）',
};

const SYSTEM_PROMPT = `あなたはキャラクター属性の抽出器です。与えられたファンサイト記事の本文から、指定された属性だけを抽出します。次の手順を厳守してください。

1. 各属性について、まず記事本文に実際に印字されている文字列をquoteへそのまま切り出します。あなたが元々持っているこのキャラクターについての知識で言い換えたり要約したりしてはいけません。本文に実在する文字列だけを使ってください。
2. quoteの前後に「」『』などの記号を新たに追加してはいけません（本文中に元々含まれる記号はそのまま残してよいですが、あなたが装飾として付け足すことは禁止します）。
3. 次に、そのquoteだけを根拠にvalueを判定します。quoteに書かれていない内容をvalueにしてはいけません。
4. valueは指定された選択肢の中からのみ選びます。選択肢以外の言葉を使ってはいけません。
5. 記事本文に根拠となる記述が見当たらない属性は、quoteを空文字、valueを「該当なし」、confidenceを「none」にします。このキャラクターについてあなたが元々知っている一般的な知識やイメージで埋めてはいけません——根拠は必ずこの記事本文の中だけから探し、見つからなければ正直に「該当なし」にしてください。
6. 根拠はあるが判定に迷う場合はconfidenceを「low」、明確に判定できる場合は「high」にします。
7. roles（関係性の役割）は複数該当し得ます。本文から確認できるものだけを列挙してください。無理に埋める必要はありません。`;

/**
 * questions.json の既存 axis-type ソースから各軸の列挙値を実データ駆動で導出する
 * （schema.tsの値配列をこのスクリプトへ手打ちコピーするとドリフトし得るため。
 * axis-only 38問は全てこの7軸の列挙値を1問1値でカバーしている——手打ちコピーより
 * 確実に一致する）。
 * @param {{ questions: { sources: { type: string, axis?: string, value?: string }[] }[] }} questionsFile
 */
export function deriveAxisEnums(questionsFile) {
  const enums = Object.fromEntries(LLM_AXIS_KEYS.map((k) => [k, []]));
  const seen = Object.fromEntries(LLM_AXIS_KEYS.map((k) => [k, new Set()]));
  for (const q of questionsFile.questions) {
    for (const s of q.sources) {
      if (s.type !== 'axis' || !s.axis || !LLM_AXIS_KEYS.includes(s.axis)) continue;
      if (seen[s.axis].has(s.value)) continue;
      seen[s.axis].add(s.value);
      enums[s.axis].push(s.value);
    }
  }
  return enums;
}

/**
 * @param {string[]} values
 */
function singleAxisFieldSchema(values) {
  return {
    type: 'object',
    properties: {
      quote: { type: 'string' },
      value: { type: 'string', enum: [...values, '該当なし'] },
      confidence: { type: 'string', enum: ['high', 'low', 'none'] },
    },
    required: ['quote', 'value', 'confidence'],
  };
}

/**
 * @param {Record<string, string[]>} axisEnums
 */
function buildCombinedFormatSchema(axisEnums) {
  const properties = {};
  for (const key of SINGLE_VALUE_AXES) {
    properties[key] = singleAxisFieldSchema(axisEnums[key]);
  }
  properties.roles = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        quote: { type: 'string' },
        value: { type: 'string', enum: axisEnums.roles },
        confidence: { type: 'string', enum: ['high', 'low', 'none'] },
      },
      required: ['quote', 'value', 'confidence'],
    },
  };
  return { type: 'object', properties, required: [...SINGLE_VALUE_AXES, 'roles'] };
}

/**
 * @param {string} articleText
 * @param {Record<string, string[]>} axisEnums
 */
export function buildUserPrompt(articleText, axisEnums) {
  const lines = LLM_AXIS_KEYS.map((key) => `- ${key}（${AXIS_LABELS[key]}）: ${axisEnums[key].join('/')}`);
  return `次の記事本文からキャラクターの属性を抽出してください。判定対象の属性と選択肢:\n${lines.join('\n')}\n\n---\n${articleText}`;
}

/**
 * @param {string} axisKey
 * @param {Record<string, string[]>} axisEnums
 * @param {string} failedQuote
 */
function buildRetryPrompt(articleText, axisKey, axisEnums, failedQuote) {
  const label = AXIS_LABELS[axisKey];
  const values = axisEnums[axisKey].join('/');
  return `次の記事本文から、キャラクターの「${label}」だけを抽出してください。選択肢: ${values}\n\n前回の回答は引用「${failedQuote}」が原文中に見つからず、原文に実在しない引用でした。原文に実際に書かれている一節だけを逐語で引用してください。原文に根拠が見当たらなければquoteを空文字、valueを「該当なし」、confidenceを「none」にしてください。\n\n---\n${articleText}`;
}

/** 「」『』のどちらの対応する外側1組だけを剥がす（ネストや本文由来の内部の
 * 括弧はそのまま扱う——2回以上剥がすと本文自体に含まれる括弧まで誤って
 * 剥がしてしまうため1回限り）。 */
const WRAPPING_BRACKET_PAIRS = [
  ['「', '」'],
  ['『', '』'],
];

/**
 * quoteの前後を装飾する「」『』を1組だけ取り除く。プロンプトで明示的に禁止しても
 * qwen3が引用を「」で装飾してしまう癖が実地確認で強く残ることが分かった
 * （2026-07-25、touhou-reimuで本文に実在する引用9件中6件がこの装飾のせいだけで
 * 照合に失敗し、剥がすと本物と判定できた）。これは「捏造」ではなく書式上の癖への
 * 対処であり、剥がした後も実在チェック自体は変わらず厳格に行う——装飾を剥がして
 * もなお本文に無ければ従来通り不採用にする。
 * @param {string} quote
 * @returns {string}
 */
export function stripWrappingBrackets(quote) {
  const trimmed = quote.trim();
  for (const [open, close] of WRAPPING_BRACKET_PAIRS) {
    if (trimmed.startsWith(open) && trimmed.endsWith(close) && trimmed.length > open.length + close.length) {
      return trimmed.slice(open.length, -close.length);
    }
  }
  return trimmed;
}

/**
 * quoteが正規化後の記事本文に実在するか（LLMを信用しない決定論チェック）。
 * @param {string} articleText htmlToTextで正規化済みの本文
 * @param {string} quote
 */
export function verifyQuote(articleText, quote) {
  if (!quote) return false;
  const normalizedQuote = normalizeWhitespace(stripWrappingBrackets(quote));
  if (normalizedQuote.length < MIN_QUOTE_LENGTH) return false;
  return normalizeWhitespace(articleText).includes(normalizedQuote);
}

/**
 * 単一値の軸を照合し、幻覚引用ならMAX_LLM_RETRIESまで再プロンプトする。
 * @param {{
 *   ollamaChat: ReturnType<typeof createOllamaClient>, articleText: string, axisKey: string,
 *   initial: { quote: string, value: string, confidence: string }, axisEnums: Record<string, string[]>,
 *   verification: object[],
 * }} params
 */
async function resolveSingleAxis({ ollamaChat, articleText, axisKey, initial, axisEnums, verification }) {
  let current = initial;
  let attempt = 0;
  for (;;) {
    if (current.value === '該当なし' || current.confidence === 'none') {
      verification.push({ axis: axisKey, quote: current.quote ?? '', matched: null, retries: attempt });
      return { value: '該当なし', verified: false, confidence: 'none' };
    }
    const matched = verifyQuote(articleText, current.quote);
    verification.push({ axis: axisKey, quote: current.quote, matched, retries: attempt });
    if (matched) {
      return { value: current.value, verified: true, confidence: current.confidence };
    }
    if (attempt >= MAX_LLM_RETRIES) {
      return { value: current.value, verified: false, confidence: current.confidence };
    }
    attempt += 1;
    current = await ollamaChat({
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildRetryPrompt(articleText, axisKey, axisEnums, current.quote),
      format: singleAxisFieldSchema(axisEnums[axisKey]),
      seed: SEED,
    });
  }
}

/**
 * roles(複数値軸)の照合。未列挙は無情報として扱う設計のため、単一値軸のような
 * 再プロンプトはせず、照合に落ちた/confidenceがhighでない候補は静かに落とす
 * （安全側——不採用は「未確認」に留まりnull寄与になるだけで実害が無い）。
 * @param {string} articleText
 * @param {{ quote: string, value: string, confidence: string }[]} initialEntries
 * @param {object[]} verification
 */
function resolveRolesAxis(articleText, initialEntries, verification) {
  const accepted = [];
  for (const entry of initialEntries) {
    const matched = verifyQuote(articleText, entry.quote);
    verification.push({ axis: 'roles', role: entry.value, quote: entry.quote, matched, retries: 0 });
    if (matched && entry.confidence === 'high') accepted.push(entry.value);
  }
  const values = [...new Set(accepted)];
  return { values, verified: values.length > 0, confidence: values.length > 0 ? 'high' : 'none' };
}

/**
 * @typedef {{ value: string, verified: boolean, confidence: string }} SingleAxisResult
 * @typedef {{ values: string[], verified: boolean, confidence: string }} RolesResult
 * @typedef {{
 *   personality: SingleAxisResult, mood: SingleAxisResult, species: SingleAxisResult,
 *   combat: SingleAxisResult, distance: SingleAxisResult, affiliationKind: SingleAxisResult,
 *   roles: RolesResult,
 * }} ExtractedAxes
 * @typedef {{ axis: string, quote: string, matched: boolean | null, retries: number, role?: string }} VerificationEntry
 */

/**
 * @param {{ ollamaChat: ReturnType<typeof createOllamaClient>, articleText: string, axisEnums: Record<string, string[]> }} params
 * @returns {Promise<{ axes: ExtractedAxes, verification: VerificationEntry[], rawResponse: unknown }>}
 */
export async function extractOneCharacter({ ollamaChat, articleText, axisEnums }) {
  const initial = await ollamaChat({
    model: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(articleText, axisEnums),
    format: buildCombinedFormatSchema(axisEnums),
    seed: SEED,
  });

  const verification = [];
  /** @type {ExtractedAxes} */
  const axes = /** @type {any} */ ({});
  for (const axisKey of SINGLE_VALUE_AXES) {
    axes[axisKey] = await resolveSingleAxis({
      ollamaChat,
      articleText,
      axisKey,
      initial: initial[axisKey],
      axisEnums,
      verification,
    });
  }
  axes.roles = resolveRolesAxis(articleText, initial.roles ?? [], verification);

  return { axes, verification, rawResponse: initial };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const charFilter = args.includes('--char') ? args[args.indexOf('--char') + 1] : null;

  const dataDir = new URL('../../data/', import.meta.url);
  const charactersPath = fileURLToPath(new URL('characters.json', dataDir));
  const questionsPath = fileURLToPath(new URL('bayes/questions.json', dataDir));
  const extractPath = fileURLToPath(new URL('bayes/llm-extract.json', dataDir));
  const niconicoCacheDir = fileURLToPath(new URL('../../state/bayes-pipeline/niconico/', import.meta.url));
  const llmCacheDir = fileURLToPath(new URL('../../state/bayes-pipeline/llm/', import.meta.url));

  const characters = JSON.parse(readFileSync(charactersPath, 'utf8'));
  const questionsFile = JSON.parse(readFileSync(questionsPath, 'utf8'));
  const axisEnums = deriveAxisEnums(questionsFile);

  let llmExtract = { version: 1, model: MODEL, seed: SEED, entries: {} };
  try {
    llmExtract = JSON.parse(readFileSync(extractPath, 'utf8'));
  } catch (_err) {
    // 初回実行。
  }

  mkdirSync(llmCacheDir, { recursive: true });

  const targets = charFilter ? characters.filter((c) => c.id === charFilter) : characters;
  if (charFilter && targets.length === 0) {
    console.error(`指定されたキャラid「${charFilter}」が見つかりません。`);
    process.exitCode = 1;
    return;
  }

  const pending = targets.filter((c) => force || charFilter || !llmExtract.entries[c.id]);
  if (pending.length === 0) {
    console.log('全キャラ、抽出済みです（--force で再実行）。');
    return;
  }
  console.log(`LLM抽出対象 ${pending.length} 件`);

  const ollamaChat = createOllamaClient({});
  const noCoverage = [];
  const errors = [];
  let attempted = 0;
  let verifiedCount = 0;
  let evidenceAttempts = 0;

  for (const [index, character] of pending.entries()) {
    process.stdout.write(`[${index + 1}/${pending.length}] ${character.name} (${character.id}) ... `);

    const niconicoCachePath = join(niconicoCacheDir, `${character.id}.json`);
    let cached;
    try {
      cached = JSON.parse(readFileSync(niconicoCachePath, 'utf8'));
    } catch (_err) {
      console.log('ニコニコ記事キャッシュなし（map-niconico.mjs未実行/記事なし）。スキップ。');
      noCoverage.push({ id: character.id, name: character.name });
      continue;
    }

    attempted += 1;
    const startedAt = new Date().toISOString();
    let result;
    try {
      result = await extractOneCharacter({ ollamaChat, articleText: cached.text, axisEnums });
    } catch (err) {
      console.log(`抽出失敗: ${err.message}`);
      errors.push({ id: character.id, name: character.name, issue: err.message });
      continue;
    }
    const finishedAt = new Date().toISOString();

    writeFileSync(
      join(llmCacheDir, `${character.id}.json`),
      `${JSON.stringify(
        {
          charId: character.id,
          article: cached.title,
          model: MODEL,
          seed: SEED,
          rawResponse: result.rawResponse,
          axes: result.axes,
          verification: result.verification,
          startedAt,
          finishedAt,
        },
        null,
        2,
      )}\n`,
    );

    llmExtract.entries[character.id] = { article: cached.title, axes: result.axes };
    llmExtract.model = MODEL;
    llmExtract.seed = SEED;
    writeFileSync(extractPath, `${JSON.stringify(llmExtract, null, 2)}\n`);

    for (const v of result.verification) {
      if (v.matched === null) continue; // 該当なし経路はゲート対象外（試行に数えない）
      evidenceAttempts += 1;
      if (v.matched) verifiedCount += 1;
    }

    const summary = SINGLE_VALUE_AXES.map((k) => (result.axes[k].value === '該当なし' ? null : `${k}=${result.axes[k].value}`))
      .filter(Boolean)
      .join(', ');
    const rolesSummary = result.axes.roles.values.join('/') || 'なし';
    console.log(`完了 (${summary || '該当なし'}, roles=${rolesSummary})`);
  }

  const passRate = evidenceAttempts > 0 ? `${((verifiedCount / evidenceAttempts) * 100).toFixed(1)}%` : 'N/A';
  console.log(`\n完了。${pending.length} 件中 ${attempted} 件を抽出しました（記事キャッシュなし ${noCoverage.length} 件）。`);
  console.log(`引用照合ゲート通過率: ${verifiedCount}/${evidenceAttempts} (${passRate})`);

  if (noCoverage.length > 0) {
    console.log(`\n=== 記事キャッシュなし（要: map-niconico.mjs実行/記事自体が存在しない） ${noCoverage.length} 件 ===`);
    for (const r of noCoverage) console.log(`  ${r.id} (${r.name})`);
  }
  if (errors.length > 0) {
    console.log(`\n=== 抽出失敗 ${errors.length} 件 ===`);
    for (const r of errors) console.log(`  ${r.id} (${r.name}): ${r.issue}`);
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  await main();
}
