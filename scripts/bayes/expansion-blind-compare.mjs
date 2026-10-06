#!/usr/bin/env node
/**
 * 1000体拡張: 下書き担当（journal.jsonl の result.drafts）と、独立に付け直した
 * 担当（result.annotations）を id で突き合わせ、軸ごとの一致率を出す。採否の
 * 判断はしない——あくまで両者の値を比較して集計するだけ。
 *
 * 比較対象の軸は affiliationName を除く17軸:
 *   - 値に順序がある単一値軸（ageFeel/build/bust/stature/distance）は完全一致率に
 *     加えて「語彙上1段以内の一致率」も出す。
 *   - その他の単一値軸（genderExpression/skinTone/species/combat/affiliationKind）は
 *     完全一致率のみ。
 *   - 配列軸（personality/roles/looks/hairColor/outfit/mood/occupation）は集合として
 *     比較し、Jaccard係数の平均と完全一致率を出す。
 *   - affiliationName はシリーズ固有の自由記述で語彙も順序も無いため比較しない。
 *
 * 比較の約束（judgmentではなく集計上の取り決め）:
 *   - 値が無い（単一値はnull、配列は[]）のは「未設定」という1つの状態として扱う。
 *     両者とも未設定なら一致（nullとnullも、[]と[]も一致）とみなす——「両者とも
 *     確証が無く空けた」もここでは意見の一致として数える。
 *   - 下書き側に除外flags（same-as:*・not-a-character・player-avatar・male・
 *     unreleased）が付いているキャラは比較から外す（除外前提のため軸の比較自体に
 *     意味が無い）。
 *   - n はその軸で実際に比較したキャラ数（= 全軸共通。drafts と annotations の
 *     両方に id があり、除外flagsが無いキャラの数）。
 *
 * 使い方: node scripts/bayes/expansion-blind-compare.mjs --journal <journal.jsonlのパス>
 * 出力: state/expansion/blind-compare.json と標準出力の表。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 値に順序がある単一値軸の語彙（1段以内判定のための位置づけに使う。
 * src/data/schema.ts の *_VALUES と同じ値・同じ順。2026-10-06確認、食い違いなし）。
 */
const ORDERED_VOCAB = {
  ageFeel: ['幼い', '同年代', '年上', '熟れた'],
  build: ['華奢', '標準', 'むっちり'],
  bust: ['小さい', '標準', '大きい', 'とても大きい'],
  stature: ['小柄', '標準', '長身'],
  distance: ['積極的', 'やや積極的', '中立', 'やや受け身', '受け身'],
};
const ORDERED_SINGLE_AXES = Object.keys(ORDERED_VOCAB);
const UNORDERED_SINGLE_AXES = ['genderExpression', 'skinTone', 'species', 'combat', 'affiliationKind'];
const ARRAY_AXES_LIST = ['personality', 'roles', 'looks', 'hairColor', 'outfit', 'mood', 'occupation'];
// affiliationName は比較しない（自由記述・語彙なし）。

/** 下書きの flags のうち、これらが1つでも付いていれば比較から外す。apply側と同じ条件。 */
function isExcludedByFlags(flags) {
  return (flags ?? []).some(
    (f) => f === 'not-a-character' || f === 'player-avatar' || f === 'male' || f === 'unreleased' || f.startsWith('same-as:'),
  );
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/**
 * journal.jsonl から result.drafts と result.annotations を id で集める
 * （同じidが複数回現れたら最後のものを採用。journal読み取り時の行壊れは無視）。
 * @returns {{ drafts: Map<string, object>, annotations: Map<string, object> }}
 */
export function loadJournalResults(journalPath) {
  const drafts = new Map();
  const annotations = new Map();
  const lines = readFileSync(journalPath, 'utf8').split('\n');
  for (const line of lines) {
    if (line.trim() === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_err) {
      continue;
    }
    if (obj.type !== 'result') continue;
    for (const d of obj.result?.drafts ?? []) drafts.set(d.id, d);
    for (const a of obj.result?.annotations ?? []) annotations.set(a.id, a);
  }
  return { drafts, annotations };
}

function getSingleValue(axes, axis) {
  const v = axes?.[axis];
  return v === undefined ? null : v;
}

function getArrayValue(axes, axis) {
  const v = axes?.[axis];
  return Array.isArray(v) ? v : [];
}

/** 両方空なら1（未設定で一致）、どちらかが空なら合併が空でない限りその比率。 */
export function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const v of setA) if (setB.has(v)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

export function setEqual(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const v of setA) if (!setB.has(v)) return false;
  return true;
}

/** 語彙上の位置の差。どちらかが未設定で両方未設定なら0（一致）、片方のみ未設定/語彙外ならInfinity。 */
export function orderedDistance(vocab, a, b) {
  if (a === null && b === null) return 0;
  const ia = a === null ? -1 : vocab.indexOf(a);
  const ib = b === null ? -1 : vocab.indexOf(b);
  if (ia === -1 || ib === -1) return Infinity;
  return Math.abs(ia - ib);
}

function main() {
  const args = process.argv.slice(2);
  const getArg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

  const journalArg = getArg('--journal');
  if (!journalArg) {
    console.error('使い方: node scripts/bayes/expansion-blind-compare.mjs --journal <journal.jsonlのパス>');
    process.exitCode = 1;
    return;
  }

  const { drafts, annotations } = loadJournalResults(journalArg);

  let skippedExcludedFlagged = 0;
  const comparableIds = [];
  for (const [id, draft] of drafts) {
    if (isExcludedByFlags(draft.flags)) {
      if (annotations.has(id)) skippedExcludedFlagged += 1;
      continue;
    }
    if (annotations.has(id)) comparableIds.push(id);
  }
  comparableIds.sort();
  const n = comparableIds.length;

  const axes = {};
  const mismatches = [];

  for (const axis of UNORDERED_SINGLE_AXES) {
    let exact = 0;
    for (const id of comparableIds) {
      const dv = getSingleValue(drafts.get(id).axes, axis);
      const bv = getSingleValue(annotations.get(id).axes, axis);
      if (dv === bv) exact += 1;
      else mismatches.push({ id, axis, draft: dv, blind: bv });
    }
    axes[axis] = { n, exact };
  }

  for (const axis of ORDERED_SINGLE_AXES) {
    const vocab = ORDERED_VOCAB[axis];
    let exact = 0;
    let within1 = 0;
    for (const id of comparableIds) {
      const dv = getSingleValue(drafts.get(id).axes, axis);
      const bv = getSingleValue(annotations.get(id).axes, axis);
      const isExact = dv === bv;
      if (isExact) exact += 1;
      else mismatches.push({ id, axis, draft: dv, blind: bv });
      if (orderedDistance(vocab, dv, bv) <= 1) within1 += 1;
    }
    axes[axis] = { n, exact, within1 };
  }

  for (const axis of ARRAY_AXES_LIST) {
    let exact = 0;
    let jaccardSum = 0;
    for (const id of comparableIds) {
      const dv = getArrayValue(drafts.get(id).axes, axis);
      const bv = getArrayValue(annotations.get(id).axes, axis);
      if (setEqual(dv, bv)) exact += 1;
      else mismatches.push({ id, axis, draft: dv, blind: bv });
      jaccardSum += jaccard(dv, bv);
    }
    axes[axis] = { n, exact, jaccard: n > 0 ? round3(jaccardSum / n) : null };
  }

  const stateDir = fileURLToPath(new URL('../../state/expansion/', import.meta.url));
  mkdirSync(stateDir, { recursive: true });
  const reportPath = join(stateDir, 'blind-compare.json');
  const report = {
    generatedAt: new Date().toISOString(),
    draftsTotal: drafts.size,
    annotationsTotal: annotations.size,
    compared: n,
    skippedExcludedFlagged,
    axes,
    mismatches,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`drafts: ${drafts.size} 件 / annotations: ${annotations.size} 件 / 比較対象: ${n} 件(除外flagsで対象外: ${skippedExcludedFlagged} 件)`);
  console.log('');
  // 列ごとに幅を変える。先頭の軸名列は最長の'genderExpression'(16文字)が収まる幅にする。
  const COLUMN_WIDTHS = [18, 6, 7, 9, 9, 11, 8];
  const header = ['軸', 'n', 'exact', 'exact率', 'within1', 'within1率', 'jaccard'];
  console.log(header.map((h, i) => h.padEnd(COLUMN_WIDTHS[i])).join(''));
  for (const axis of [...UNORDERED_SINGLE_AXES, ...ORDERED_SINGLE_AXES, ...ARRAY_AXES_LIST]) {
    const stat = axes[axis];
    const exactRate = stat.n > 0 ? `${((stat.exact / stat.n) * 100).toFixed(1)}%` : 'N/A';
    const within1Rate = stat.within1 !== undefined && stat.n > 0 ? `${((stat.within1 / stat.n) * 100).toFixed(1)}%` : '';
    const row = [
      axis,
      String(stat.n),
      String(stat.exact),
      exactRate,
      stat.within1 !== undefined ? String(stat.within1) : '',
      within1Rate,
      stat.jaccard !== undefined && stat.jaccard !== null ? String(stat.jaccard) : '',
    ];
    console.log(row.map((c, i) => c.padEnd(COLUMN_WIDTHS[i])).join(''));
  }
  console.log('');
  console.log(`不一致: ${mismatches.length} 件。詳細: ${reportPath}`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
