#!/usr/bin/env node
/**
 * 複数のローカルLLM（llama-server の models.ini 名）を、同じ査読済みキャラ標本で比較する。
 * llm-extract.mjs の evidence-first 抽出（extractOneCharacter）をそのまま使い、モデルだけを
 * 差し替えて「査読済みの値との一致率」を中心に横並びで測る。
 *
 * data/bayes/llm-extract.json（本番データ）には一切書き込まない。結果は
 * <state>/bayes-pipeline/bench/<ISO時刻>.json（gitignore、監査用）に各モデルの runInfo と
 * 一緒に残す。
 *
 * 使い方:
 *   node scripts/bayes/bench-llm-models.mjs --models m1,m2 [--sample-size 30] [--seed 1]
 *     [--chars id1,id2] [--state-dir <dir>] [--out-dir <dir>]
 *
 * 標本: reviewed:true かつ <state>/bayes-pipeline/niconico/<id>.json があるキャラを id 昇順に
 * 並べ、--seed の固定 seed でシャッフルして先頭 --sample-size 体。全モデルに同じ標本を使う。
 * --chars を渡すとその id（同じ条件を満たすもの）だけを使う。
 * state の場所は --state-dir か環境変数 BAYES_STATE_DIR（既定はリポジトリ内の state/）。
 * 出力先は --out-dir（既定 <state>/bayes-pipeline/bench）。読み取り専用の state を指すときに使う。
 *
 * 指標（モデルごと）:
 *   - 一致率 = 一致 /（一致+不一致）。採点するのは llm-extract と同じ採用条件
 *     （引用照合を通り confidence が high。estimateLlmLikelihood が使う値）を満たした値だけ。
 *     単一値の軸は、抽出値が査読値（data/characters.json の axes。配列ならその要素）に
 *     含まれれば一致。複数値の軸（roles, occupation）は、採用された値ひとつずつを査読値の
 *     集合に含まれるかで数える。査読値が null や空配列の枠は正解が無いので採点しない。
 *   - 被覆率 = 採点対象の枠（キャラ×軸、査読値あり）のうち採用値を1つ以上出した割合。
 *     抽出が失敗したキャラの枠も分母に入る（失敗は被覆しなかった扱い）。
 *   - 引用照合の通過率 = 照合を試みた引用のうち原文に実在したもの（再試行分も含む）。
 *   - 空欄の割合 = 全枠（キャラ×11軸）のうち、モデルが初回応答で「該当なし」/空配列を返した割合
 *     （照合や confidence で落ちたものは含まない。モデル自身が答えなかった割合）。
 *   - 途中で切れた数 = max_tokens で切れて抽出が失敗したキャラ数（code:'TRUNCATED'）。
 *   - 1体あたりの秒数 = 抽出（再試行を含む）にかかった時間の平均。モデルの読み込み時間は
 *     runInfo の段階で済ませるので含まない。
 *   - 軸ごとの一致率。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  LLM_AXIS_KEYS,
  MULTI_VALUE_AXES,
  SEED,
  deriveAxisEnums,
  extractOneCharacter,
  resolveStateDir,
} from './llm-extract.mjs';
import { createLlmClient, runInfo } from './llm-client.mjs';

const DEFAULT_SAMPLE_SIZE = 30;
const DEFAULT_SHUFFLE_SEED = 1;

/** 決定論的な32bit乱数（mulberry32）。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 固定 seed の Fisher-Yates シャッフル（入力は変更しない）。
 * @template T
 * @param {T[]} items
 * @param {number} seed
 * @returns {T[]}
 */
export function seededShuffle(items, seed) {
  const out = [...items];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * 標本の id。reviewed:true かつ記事キャッシュがあるキャラを id 昇順→固定 seed でシャッフル→先頭 n 体。
 * @param {{ characters: { id: string, reviewed?: boolean }[], hasArticle: (id: string) => boolean,
 *   sampleSize: number, seed: number, onlyIds?: string[] | null }} params
 * @returns {string[]}
 */
export function pickSample({ characters, hasArticle, sampleSize, seed, onlyIds = null }) {
  const eligible = characters
    .filter((c) => c.reviewed === true && hasArticle(c.id))
    .map((c) => c.id)
    .sort();
  if (onlyIds) return onlyIds.filter((id) => eligible.includes(id));
  return seededShuffle(eligible, seed).slice(0, sampleSize);
}

/**
 * 査読値を集合にする。null/空配列/空文字は正解なし（null を返す）。
 * @param {unknown} reviewed
 * @returns {Set<string> | null}
 */
function reviewedSet(reviewed) {
  if (reviewed === null || reviewed === undefined || reviewed === '') return null;
  const values = Array.isArray(reviewed) ? reviewed.filter((v) => typeof v === 'string' && v !== '') : [reviewed];
  return values.length > 0 ? new Set(/** @type {string[]} */ (values)) : null;
}

/**
 * 採用値（llm-extract と同じ条件: verified===true かつ confidence==='high'）。
 * @param {string} axis
 * @param {any} extracted extractOneCharacter の axes[axis]
 * @returns {string[]}
 */
export function adoptedValues(axis, extracted) {
  if (!extracted || extracted.verified !== true || extracted.confidence !== 'high') return [];
  if (MULTI_VALUE_AXES.includes(axis)) return Array.isArray(extracted.values) ? extracted.values : [];
  const v = extracted.value;
  return v === null || v === undefined || v === '' || v === '該当なし' ? [] : [v];
}

/**
 * 1キャラ分の採点。
 * @param {{ reviewedAxes: Record<string, unknown>, result: { axes: Record<string, any>, verification: { matched: boolean | null }[], rawResponse: any } | null }} params
 *   result が null なら抽出失敗（採点対象の枠は全部未被覆として数える）。
 */
export function scoreCharacter({ reviewedAxes, result }) {
  /** @type {Record<string, { match: number, mismatch: number, scoredSlots: number, coveredSlots: number }>} */
  const perAxis = {};
  let blankSlots = 0;
  let quoteChecked = 0;
  let quotePassed = 0;
  for (const axis of LLM_AXIS_KEYS) {
    const stats = { match: 0, mismatch: 0, scoredSlots: 0, coveredSlots: 0 };
    perAxis[axis] = stats;
    if (result) {
      const raw = result.rawResponse?.[axis];
      const blank = MULTI_VALUE_AXES.includes(axis)
        ? !Array.isArray(raw) || raw.length === 0
        : !raw || raw.value === '該当なし' || raw.confidence === 'none';
      if (blank) blankSlots += 1;
    }
    const truth = reviewedSet(reviewedAxes?.[axis]);
    if (!truth) continue;
    stats.scoredSlots = 1;
    if (!result) continue;
    const adopted = adoptedValues(axis, result.axes[axis]);
    if (adopted.length === 0) continue;
    stats.coveredSlots = 1;
    for (const v of adopted) {
      if (truth.has(v)) stats.match += 1;
      else stats.mismatch += 1;
    }
  }
  if (result) {
    for (const v of result.verification) {
      if (v.matched === null) continue;
      quoteChecked += 1;
      if (v.matched) quotePassed += 1;
    }
  }
  return { perAxis, blankSlots, totalSlots: result ? LLM_AXIS_KEYS.length : 0, quoteChecked, quotePassed };
}

const ratio = (num, den) => (den > 0 ? num / den : null);

/**
 * キャラごとの採点を合算してモデルの指標にする。
 * @param {{ elapsedMs: number, error?: string, errorCode?: string, score: ReturnType<typeof scoreCharacter> }[]} perChar
 */
export function summarizeModel(perChar) {
  const perAxis = Object.fromEntries(
    LLM_AXIS_KEYS.map((axis) => [axis, { match: 0, mismatch: 0, scoredSlots: 0, coveredSlots: 0 }]),
  );
  let blankSlots = 0;
  let totalSlots = 0;
  let quoteChecked = 0;
  let quotePassed = 0;
  let totalMs = 0;
  for (const c of perChar) {
    totalMs += c.elapsedMs;
    blankSlots += c.score.blankSlots;
    totalSlots += c.score.totalSlots;
    quoteChecked += c.score.quoteChecked;
    quotePassed += c.score.quotePassed;
    for (const axis of LLM_AXIS_KEYS) {
      for (const k of ['match', 'mismatch', 'scoredSlots', 'coveredSlots']) perAxis[axis][k] += c.score.perAxis[axis][k];
    }
  }
  const sum = (k) => LLM_AXIS_KEYS.reduce((acc, axis) => acc + perAxis[axis][k], 0);
  const match = sum('match');
  const mismatch = sum('mismatch');
  const scoredSlots = sum('scoredSlots');
  const coveredSlots = sum('coveredSlots');
  return {
    characters: perChar.length,
    errors: perChar.filter((c) => c.error).length,
    truncated: perChar.filter((c) => c.errorCode === 'TRUNCATED').length,
    match,
    mismatch,
    accuracy: ratio(match, match + mismatch),
    scoredSlots,
    coveredSlots,
    coverage: ratio(coveredSlots, scoredSlots),
    quoteChecked,
    quotePassed,
    quotePassRate: ratio(quotePassed, quoteChecked),
    blankSlots,
    totalSlots,
    blankRate: ratio(blankSlots, totalSlots),
    avgSecPerChar: perChar.length > 0 ? totalMs / perChar.length / 1000 : null,
    perAxis: Object.fromEntries(
      LLM_AXIS_KEYS.map((axis) => [
        axis,
        { ...perAxis[axis], accuracy: ratio(perAxis[axis].match, perAxis[axis].match + perAxis[axis].mismatch) },
      ]),
    ),
  };
}

const pct = (x) => (x === null ? 'N/A' : `${(x * 100).toFixed(1)}%`);

/**
 * @param {{ model: string, summary: ReturnType<typeof summarizeModel> }[]} results
 */
export function formatTable(results) {
  const header = ['model', '一致率', '一致/不一致', '被覆率', '引用照合', '空欄', '切れ', '失敗', '秒/体'];
  const rows = results.map(({ model, summary: s }) => [
    model,
    pct(s.accuracy),
    `${s.match}/${s.mismatch}`,
    pct(s.coverage),
    pct(s.quotePassRate),
    pct(s.blankRate),
    String(s.truncated),
    String(s.errors),
    s.avgSecPerChar === null ? 'N/A' : s.avgSecPerChar.toFixed(1),
  ]);
  const axisHeader = ['model', ...LLM_AXIS_KEYS];
  const axisRows = results.map(({ model, summary: s }) => [
    model,
    ...LLM_AXIS_KEYS.map((axis) => {
      const a = s.perAxis[axis];
      return `${pct(a.accuracy)}(${a.match}/${a.match + a.mismatch})`;
    }),
  ]);
  const toMd = (h, rs) => [h, h.map(() => '---'), ...rs].map((r) => `| ${r.join(' | ')} |`).join('\n');
  return `${toMd(header, rows)}\n\n軸ごとの一致率（一致/採点数）\n${toMd(axisHeader, axisRows)}`;
}

async function benchOneModel({ model, llmChat, sample, articles, reviewedById, axisEnums }) {
  const perChar = [];
  for (const id of sample) {
    const t0 = Date.now();
    let result = null;
    let error;
    let errorCode;
    try {
      result = await extractOneCharacter({ llmChat, articleText: articles.get(id), axisEnums, model });
    } catch (err) {
      error = err.message;
      errorCode = err.code;
    }
    const elapsedMs = Date.now() - t0;
    const score = scoreCharacter({ reviewedAxes: reviewedById.get(id), result });
    const entry = { id, elapsedMs, score, ...(error ? { error, errorCode } : {}), axes: result?.axes ?? null };
    perChar.push(entry);
    const m = LLM_AXIS_KEYS.reduce((acc, a) => acc + score.perAxis[a].match, 0);
    const mm = LLM_AXIS_KEYS.reduce((acc, a) => acc + score.perAxis[a].mismatch, 0);
    process.stdout.write(
      `    [${model}] ${id}: ${(elapsedMs / 1000).toFixed(1)}s, ` +
        (error ? `失敗(${errorCode ?? 'ERROR'}): ${error.slice(0, 120)}\n` : `一致${m}/不一致${mm}, 照合${score.quotePassed}/${score.quoteChecked}\n`),
    );
  }
  return perChar;
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const modelsArg = argValue(args, '--models');
  if (!modelsArg) {
    console.error('--models m1,m2,... を指定してください（~/tools/localllm/models.ini のセクション名）。');
    process.exitCode = 1;
    return;
  }
  const models = modelsArg.split(',').map((s) => s.trim()).filter(Boolean);
  const charsArg = argValue(args, '--chars');
  const onlyIds = charsArg ? charsArg.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const sampleSize = Number(argValue(args, '--sample-size') ?? DEFAULT_SAMPLE_SIZE);
  const shuffleSeed = Number(argValue(args, '--seed') ?? DEFAULT_SHUFFLE_SEED);
  if (!Number.isInteger(sampleSize) || sampleSize <= 0 || !Number.isInteger(shuffleSeed)) {
    console.error('--sample-size は正の整数、--seed は整数で指定してください。');
    process.exitCode = 1;
    return;
  }

  const dataDir = new URL('../../data/', import.meta.url);
  const characters = JSON.parse(readFileSync(fileURLToPath(new URL('characters.json', dataDir)), 'utf8'));
  const questionsFile = JSON.parse(readFileSync(fileURLToPath(new URL('bayes/questions.json', dataDir)), 'utf8'));
  const axisEnums = deriveAxisEnums(questionsFile);

  const stateDir = resolveStateDir(args);
  const niconicoCacheDir = join(stateDir, 'bayes-pipeline', 'niconico');
  const outArg = argValue(args, '--out-dir');
  const benchDir = outArg ? resolve(outArg) : join(stateDir, 'bayes-pipeline', 'bench');

  const sample = pickSample({
    characters,
    hasArticle: (id) => existsSync(join(niconicoCacheDir, `${id}.json`)),
    sampleSize,
    seed: shuffleSeed,
    onlyIds,
  });
  if (sample.length === 0) {
    console.error(`標本キャラが0件です（${niconicoCacheDir} に査読済みキャラの記事キャッシュがありません）。`);
    process.exitCode = 1;
    return;
  }
  const articles = new Map(
    sample.map((id) => [id, JSON.parse(readFileSync(join(niconicoCacheDir, `${id}.json`), 'utf8')).text]),
  );
  const reviewedById = new Map(characters.map((c) => [c.id, c.axes]));

  console.log(`state: ${stateDir}`);
  console.log(`標本 ${sample.length} 体（shuffle seed=${shuffleSeed}）: ${sample.join(', ')}`);
  console.log(`比較対象モデル ${models.length} 件: ${models.join(', ')}\n`);

  const startedAt = new Date().toISOString();
  const llmChat = createLlmClient({});
  const results = [];
  for (const model of models) {
    console.log(`=== ${model} ===`);
    // 読み込みはここで済ませる（切り替えに数十秒かかるので、1体目の秒数に混ぜない）。
    const t0 = Date.now();
    const info = await runInfo(model);
    console.log(`  読み込み+runInfo ${((Date.now() - t0) / 1000).toFixed(1)}s（${info.build_info}, sha256 ${info.model_sha256}）`);
    const perChar = await benchOneModel({ model, llmChat, sample, articles, reviewedById, axisEnums });
    const summary = summarizeModel(perChar);
    results.push({ model, runInfo: info, summary, perChar });
    console.log(
      `  一致率 ${pct(summary.accuracy)}（${summary.match}/${summary.match + summary.mismatch}）、被覆率 ${pct(summary.coverage)}、` +
        `引用照合 ${pct(summary.quotePassRate)}、空欄 ${pct(summary.blankRate)}、切れ ${summary.truncated}、` +
        `1体 ${summary.avgSecPerChar === null ? 'N/A' : summary.avgSecPerChar.toFixed(1)}s\n`,
    );
  }

  console.log(formatTable(results));

  mkdirSync(benchDir, { recursive: true });
  const reportPath = join(benchDir, `${startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      { startedAt, finishedAt: new Date().toISOString(), stateDir, extractSeed: SEED, shuffleSeed, sampleSize, sample, results },
      null,
      2,
    )}\n`,
  );
  console.log(`\n詳細レポート: ${reportPath}`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
