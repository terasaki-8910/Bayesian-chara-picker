#!/usr/bin/env node
/**
 * 複数のローカルLLM(Ollama)を同一のキャラ標本セットで比較するベンチマーク。
 * llm-extract.mjs のevidence-first抽出ロジック（extractOneCharacter）をそのまま
 * 使い回し、モデルだけを差し替えて「引用照合ゲート通過率」「該当なし率」
 * 「所要時間」を横並びで測る。
 *
 * data/bayes/llm-extract.json（本番データ）には一切書き込まない
 * ——読み取り専用の比較用途。結果は state/bayes-pipeline/bench/<timestamp>.json
 * （gitignore、監査用）にのみ残す。
 *
 * 使い方:
 *   node scripts/bayes/bench-llm-models.mjs --models m1,m2,m3 [--chars id1,id2] [--n 8]
 *
 * --chars を指定しない場合、niconico記事キャッシュが存在するキャラから
 * 決定論的に(id昇順)先頭 --n 件（既定8件）を選ぶ。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deriveAxisEnums, extractOneCharacter } from './llm-extract.mjs';
import { createOllamaClient } from './ollama-client.mjs';

const DEFAULT_SAMPLE_SIZE = 8;

function pickSample(niconicoCacheDir, charFilterIds, n) {
  const cachedIds = readdirSync(niconicoCacheDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''))
    .sort();
  if (charFilterIds) return charFilterIds.filter((id) => cachedIds.includes(id));
  return cachedIds.slice(0, n);
}

async function benchOneModel({ model, ollamaChat, sample, niconicoCacheDir, axisEnums }) {
  const perChar = [];
  let verifiedCount = 0;
  let evidenceAttempts = 0;
  let noneCount = 0;
  let totalAxisSlots = 0;
  const startedAt = Date.now();

  for (const id of sample) {
    const cached = JSON.parse(readFileSync(join(niconicoCacheDir, `${id}.json`), 'utf8'));
    const t0 = Date.now();
    let result;
    let error = null;
    try {
      result = await extractOneCharacter({ ollamaChat, articleText: cached.text, axisEnums, model });
    } catch (err) {
      error = err.message;
    }
    const elapsedMs = Date.now() - t0;

    if (error) {
      perChar.push({ id, elapsedMs, error });
      continue;
    }

    let charVerified = 0;
    let charAttempts = 0;
    let charNone = 0;
    const singleAxes = ['personality', 'mood', 'species', 'combat', 'distance', 'affiliationKind'];
    for (const axis of singleAxes) {
      totalAxisSlots += 1;
      if (result.axes[axis].value === '該当なし') charNone += 1;
    }
    for (const v of result.verification) {
      if (v.matched === null) continue;
      charAttempts += 1;
      if (v.matched) charVerified += 1;
    }
    verifiedCount += charVerified;
    evidenceAttempts += charAttempts;
    noneCount += charNone;

    perChar.push({
      id,
      elapsedMs,
      verified: charVerified,
      attempts: charAttempts,
      noneAxes: charNone,
    });
    process.stdout.write(
      `    [${model}] ${id}: ${(elapsedMs / 1000).toFixed(1)}s, 照合${charVerified}/${charAttempts}, 該当なし${charNone}/${singleAxes.length}\n`,
    );
  }

  const totalMs = Date.now() - startedAt;
  return {
    model,
    totalMs,
    avgMsPerChar: sample.length > 0 ? Math.round(totalMs / sample.length) : 0,
    verifiedCount,
    evidenceAttempts,
    passRate: evidenceAttempts > 0 ? verifiedCount / evidenceAttempts : null,
    noneCount,
    totalAxisSlots,
    noneRate: totalAxisSlots > 0 ? noneCount / totalAxisSlots : null,
    perChar,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const modelsArg = args.includes('--models') ? args[args.indexOf('--models') + 1] : null;
  const charsArg = args.includes('--chars') ? args[args.indexOf('--chars') + 1] : null;
  const nArg = args.includes('--n') ? Number(args[args.indexOf('--n') + 1]) : DEFAULT_SAMPLE_SIZE;

  if (!modelsArg) {
    console.error('--models m1,m2,... を指定してください（ollama list のモデル名）。');
    process.exitCode = 1;
    return;
  }
  const models = modelsArg.split(',').map((s) => s.trim()).filter(Boolean);
  const charFilterIds = charsArg ? charsArg.split(',').map((s) => s.trim()).filter(Boolean) : null;

  const dataDir = new URL('../../data/', import.meta.url);
  const questionsPath = fileURLToPath(new URL('bayes/questions.json', dataDir));
  const niconicoCacheDir = fileURLToPath(new URL('../../state/bayes-pipeline/niconico/', import.meta.url));
  const benchDir = fileURLToPath(new URL('../../state/bayes-pipeline/bench/', import.meta.url));
  mkdirSync(benchDir, { recursive: true });

  const questionsFile = JSON.parse(readFileSync(questionsPath, 'utf8'));
  const axisEnums = deriveAxisEnums(questionsFile);

  const sample = pickSample(niconicoCacheDir, charFilterIds, nArg);
  if (sample.length === 0) {
    console.error('標本キャラが0件です（map-niconico.mjsで記事キャッシュを先に作ってください）。');
    process.exitCode = 1;
    return;
  }
  console.log(`標本 ${sample.length} 件: ${sample.join(', ')}`);
  console.log(`比較対象モデル ${models.length} 件: ${models.join(', ')}\n`);

  const ollamaChat = createOllamaClient({});
  const results = [];
  for (const model of models) {
    console.log(`=== ${model} ===`);
    const r = await benchOneModel({ model, ollamaChat, sample, niconicoCacheDir, axisEnums });
    results.push(r);
    console.log(
      `  合計 ${(r.totalMs / 1000).toFixed(1)}s（1体平均 ${(r.avgMsPerChar / 1000).toFixed(1)}s）、` +
        `引用照合 ${r.verifiedCount}/${r.evidenceAttempts}` +
        `${r.passRate !== null ? ` (${(r.passRate * 100).toFixed(1)}%)` : ''}、` +
        `該当なし ${r.noneCount}/${r.totalAxisSlots}` +
        `${r.noneRate !== null ? ` (${(r.noneRate * 100).toFixed(1)}%)` : ''}\n`,
    );
  }

  console.log('=== まとめ（引用照合ゲート通過率が高いほど幻覚が少ない/該当なし率が低いほど被覆が厚い） ===');
  console.log('model, 平均秒/体, 照合通過率, 該当なし率');
  for (const r of results) {
    console.log(
      `${r.model}, ${(r.avgMsPerChar / 1000).toFixed(1)}, ` +
        `${r.passRate !== null ? (r.passRate * 100).toFixed(1) : 'N/A'}%, ` +
        `${r.noneRate !== null ? (r.noneRate * 100).toFixed(1) : 'N/A'}%`,
    );
  }

  const reportPath = join(benchDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(reportPath, `${JSON.stringify({ sample, results }, null, 2)}\n`);
  console.log(`\n詳細レポート: ${reportPath}`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
