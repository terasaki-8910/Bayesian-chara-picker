#!/usr/bin/env node
/**
 * 独立の付け直し結果を集約し、質問軸ごとの回答ノイズを決定論的に生成する。
 * 通信は行わず、入力ファイル名と軸名の順序も出力へ固定する。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NOISE_MAX, NOISE_MIN } from './estimators.mjs';

const SOURCE_FILES = [
  'blind-compare-cycle1.json',
  'blind-compare-1000.json',
  'blind-compare-gap.json',
  'blind-compare-top.json',
  'blind-compare-restore.json',
  'blind-compare-series.json',
];

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function readComparison(stateDir, fileName) {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL(fileName, stateDir)), 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error(`必須の比較結果 state/expansion/${fileName} が見つかりません。`);
    }
    throw err;
  }
}

function main() {
  const stateDir = new URL('../../state/expansion/', import.meta.url);
  const outputUrl = new URL('../../data/bayes/answer-noise.json', import.meta.url);
  const totals = new Map();

  for (const fileName of SOURCE_FILES) {
    const comparison = readComparison(stateDir, fileName);
    for (const [axis, result] of Object.entries(comparison.axes)) {
      const current = totals.get(axis) ?? { n: 0, exact: 0 };
      current.n += result.n;
      current.exact += result.exact;
      totals.set(axis, current);
    }
  }

  const axes = Object.fromEntries(
    [...totals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([axis, total]) => {
        if (total.n <= 0) throw new Error(`軸 ${axis} の比較件数 n が0以下です。`);
        const agreement = total.exact / total.n;
        const e = Math.min(NOISE_MAX, Math.max(NOISE_MIN, (1 - agreement) / 2));
        return [axis, { n: total.n, agreement: round3(agreement), e: round3(e) }];
      }),
  );

  const output = {
    version: 1,
    sources: SOURCE_FILES,
    min: NOISE_MIN,
    max: NOISE_MAX,
    axes,
  };
  writeFileSync(fileURLToPath(outputUrl), `${JSON.stringify(output, null, 2)}\n`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
