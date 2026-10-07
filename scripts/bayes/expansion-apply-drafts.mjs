#!/usr/bin/env node
/**
 * 1000体拡張: 下書き担当Workflow（journal.jsonl の type==='result' 行、
 * result.drafts[]）の内容を data/characters.json 他3ファイルへ取り込む。
 *
 * 対象は data/characters.json のうち reviewed!==true かつ provisional!==true の
 * キャラ（まだ下書きが未反映の新規キャラ）のみ。除外するかどうかの判断は一切せず、
 * 下書きの flags にそのまま従う（same-as:*・not-a-character・player-avatar・male・
 * unreleased のいずれかが付いていれば除外、それ以外は軸を正規化して取り込むだけ）。
 *
 * journal は Workflow 実行中は追記され続けるため、同じ id の draft が複数回
 * 出現することがある。その場合は journal 内で最後に現れたものを採用する。
 * 本スクリプトは何度でも再実行できる（すでに適用済みのキャラも reviewed/provisional は
 * false のままなので対象に残り、同じ draft なら同じ結果に収束する）。
 *
 * 使い方:
 *   node scripts/bayes/expansion-apply-drafts.mjs --journal <journal.jsonlのパス>
 *     [--data-dir <dataディレクトリ>] [--dry-run]
 *
 * --data-dir の既定値はリポジトリの data/。テスト時はコピーした data/ を指して
 * 実データを書き換えずに確認できる。--dry-run はデータファイルへの書き込みだけを
 * 止める（state/expansion/apply-report.json は dry-run でも常に書く）。
 *
 * 出力: data/characters.json・data/bayes/tag-overrides.json・
 * data/bayes/niconico-map.json・data/bayes/llm-extract.json（--dry-run 以外）、
 * state/expansion/apply-report.json（常に）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 18軸の語彙。src/data/schema.ts の *_VALUES と同じ値・同じ順（念のため突き合わせ
 * 済み。食い違いなし、2026-10-06確認）。ARRAY_AXES に無いキーは単一値軸。
 * affiliationName は自由記述なので語彙を持たない（AXIS_VALUES に含めない）。
 * 配列への並べ替えは「重複を除き、語彙の順に並べる」ための正本としても使う。
 */
const AXIS_VALUES = {
  genderExpression: ['女性', 'おとこの娘', 'ふたなり', '男性'],
  ageFeel: ['幼い', '同年代', '年上', '熟れた'],
  build: ['華奢', '標準', 'むっちり'],
  bust: ['小さい', '標準', '大きい', 'とても大きい'],
  distance: ['積極的', 'やや積極的', '中立', 'やや受け身', '受け身'],
  skinTone: ['色白', '標準', '褐色'],
  species: ['人間', 'エルフ', '獣人', '魔族', '機械', '不死'],
  combat: ['戦う', '戦わない'],
  affiliationKind: ['学生', '社会人', '軍・組織', '冒険者', '非人間・その他'],
  stature: ['小柄', '標準', '長身'],
  personality: ['クール', '元気', 'おっとり', '生意気', '内気', '姉御', 'むっつり'],
  roles: ['幼馴染', '後輩', '先輩', '姉', '妹', '母性', '教師', '主従', 'ライバル', '恋人・伴侶', '友人'],
  looks: ['眼鏡', 'ケモミミ', '角', '尻尾', '長髪', 'ツインテール', '眼帯'],
  hairColor: ['黒', '白', '金', '茶', '赤', '青', '緑', '桃', '紫', '銀', '橙'],
  outfit: ['制服', 'メイド', '巫女', 'ナース', '魔法少女', '軍服', 'OL', '和服・着物'],
  mood: ['甘め', '支配的', '従属的', '純愛寄り', '背徳寄り'],
  occupation: [
    '忍者', '海賊', '兵士・軍人', '警察・公安', 'スパイ・暗殺者', 'アイドル・芸能',
    'アスリート', '巫女・神職', '神様・精霊', 'メイド・従者', '王族・貴族',
    '医療従事者', '研究者・発明家', '魔法使い・魔術師', '会社員・OL', '教師・講師', '格闘家・武道家',
  ],
};
const ARRAY_AXES = new Set(['personality', 'roles', 'looks', 'hairColor', 'outfit', 'mood', 'occupation']);
/** 語彙を持たない自由記述軸。invalidValues の検査対象外。 */
const FREE_TEXT_AXES = new Set(['affiliationName']);
/** 18軸すべて（単一値11 + 配列7）。この順で axes オブジェクトを組み立てる。 */
const AXIS_KEYS = [
  'genderExpression', 'ageFeel', 'build', 'bust', 'distance', 'skinTone', 'species', 'combat',
  'affiliationKind', 'affiliationName', 'stature',
  'personality', 'roles', 'looks', 'hairColor', 'outfit', 'mood', 'occupation',
];

/** ACCEPTANCE A4相当。必須8軸。 */
const REQUIRED_8 = ['genderExpression', 'ageFeel', 'build', 'bust', 'personality', 'hairColor', 'combat', 'affiliationKind'];
/** ACCEPTANCE A11相当。任意軸10個のうち4個以上埋まっていることを要求する。 */
const OPTIONAL_10 = ['roles', 'distance', 'looks', 'skinTone', 'outfit', 'species', 'mood', 'occupation', 'stature', 'affiliationName'];
const MIN_OPTIONAL_FILLED = 4;

/** 下書きの flags のうち、これらが1つでも付いていれば除外（除外の判断そのものはしない。flags に従うだけ）。 */
function isExcludedByFlags(flags) {
  return (flags ?? []).some(
    (f) => f === 'not-a-character' || f === 'player-avatar' || f === 'male' || f === 'unreleased' || f.startsWith('same-as:'),
  );
}

function isFilled(v) {
  return Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== '';
}

function isTargetCharacter(c) {
  return c.reviewed !== true && c.provisional !== true;
}

/**
 * journal.jsonl（1行1JSON）から type==='result' の行の result.drafts を id で集める。
 * 同じ id が複数回現れた場合は最後に現れたものを採用する。
 * 末尾が書き込み中で壊れている行はパース失敗として無視する（Workflow実行中の読み取り対策）。
 * @returns {Map<string, object>}
 */
export function loadDraftsFromJournal(journalPath) {
  const drafts = new Map();
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
    for (const draft of obj.result?.drafts ?? []) {
      drafts.set(draft.id, draft);
    }
  }
  return drafts;
}

/**
 * 下書きの axes を18軸すべてのキーを持つ形に正規化する。単一値は文字列かnull、
 * 配列軸は重複を除き語彙の順に並べた配列。語彙に無い値は捨てて invalidValues に
 * 記録する（破棄するだけで、採否の判断はしない）。affiliationName は自由記述なので
 * 空文字列のみ null に正規化し、語彙検査はしない。
 * @param {string} id
 * @param {object} draftAxes
 * @param {{id: string, axis: string, value: unknown}[]} invalidValues 追記先
 */
export function normalizeAxes(id, draftAxes, invalidValues) {
  const input = draftAxes ?? {};
  const result = {};
  for (const axis of AXIS_KEYS) {
    if (ARRAY_AXES.has(axis)) {
      const vocab = AXIS_VALUES[axis];
      const raw = Array.isArray(input[axis]) ? input[axis] : [];
      const valid = new Set();
      for (const v of raw) {
        if (vocab.includes(v)) valid.add(v);
        else invalidValues.push({ id, axis, value: v });
      }
      result[axis] = vocab.filter((v) => valid.has(v));
    } else if (FREE_TEXT_AXES.has(axis)) {
      const raw = input[axis];
      result[axis] = raw === null || raw === undefined || raw === '' ? null : raw;
    } else {
      const vocab = AXIS_VALUES[axis];
      const raw = input[axis] ?? null;
      if (raw === null) {
        result[axis] = null;
      } else if (vocab.includes(raw)) {
        result[axis] = raw;
      } else {
        invalidValues.push({ id, axis, value: raw });
        result[axis] = null;
      }
    }
  }
  return result;
}

/** 重複と name と同じものを除いた aliases 配列を返す（元の順を保つ）。 */
export function normalizeAliases(aliases, name) {
  const seen = new Set();
  const result = [];
  for (const a of aliases ?? []) {
    if (a === name || seen.has(a)) continue;
    seen.add(a);
    result.push(a);
  }
  return result;
}

/** ACCEPTANCE A4/A11相当の検査。問題が無ければ null を返す。 */
export function checkRequiredAndOptional(id, axes) {
  const missing = REQUIRED_8.filter((axis) => !isFilled(axes[axis]));
  const optionalFilled = OPTIONAL_10.filter((axis) => isFilled(axes[axis])).length;
  if (missing.length === 0 && optionalFilled >= MIN_OPTIONAL_FILLED) return null;
  return { id, missing, optionalFilled };
}

function emptyConfidenceByAxis() {
  const result = {};
  for (const axis of AXIS_KEYS) result[axis] = { high: 0, medium: 0, low: 0 };
  return result;
}

function emptyBasisByAxis() {
  const result = {};
  for (const axis of AXIS_KEYS) result[axis] = {};
  return result;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

  const journalArg = getArg('--journal');
  if (!journalArg) {
    console.error('使い方: node scripts/bayes/expansion-apply-drafts.mjs --journal <journal.jsonlのパス> [--data-dir <dataディレクトリ>] [--dry-run]');
    process.exitCode = 1;
    return;
  }
  const journalPath = resolve(journalArg);
  const dataDirArg = getArg('--data-dir');
  const dataDir = dataDirArg ? resolve(dataDirArg) : fileURLToPath(new URL('../../data/', import.meta.url));
  const dryRun = args.includes('--dry-run');

  const charactersPath = join(dataDir, 'characters.json');
  const overridesPath = join(dataDir, 'bayes', 'tag-overrides.json');
  const niconicoMapPath = join(dataDir, 'bayes', 'niconico-map.json');
  const llmExtractPath = join(dataDir, 'bayes', 'llm-extract.json');

  const characters = loadJson(charactersPath);
  const overridesFile = loadJson(overridesPath);
  const niconicoMap = loadJson(niconicoMapPath);
  const llmExtract = loadJson(llmExtractPath);

  const drafts = loadDraftsFromJournal(journalPath);
  const targetsTotal = characters.filter(isTargetCharacter).length;

  const missingDrafts = [];
  const excluded = [];
  const nameChanges = [];
  const invalidValues = [];
  const a4a11Failures = [];
  const confidenceByAxis = emptyConfidenceByAxis();
  const basisByAxis = emptyBasisByAxis();
  let appliedCount = 0;

  const nextCharacters = [];
  for (const character of characters) {
    if (!isTargetCharacter(character)) {
      nextCharacters.push(character);
      continue;
    }

    const draft = drafts.get(character.id);
    if (!draft) {
      missingDrafts.push({ id: character.id, name: character.name });
      nextCharacters.push(character);
      continue;
    }

    if (isExcludedByFlags(draft.flags)) {
      excluded.push({ id: character.id, name: character.name, flags: draft.flags, notes: draft.notes ?? '' });
      continue; // nextCharactersに積まない = characters.jsonから削除
    }

    const axes = normalizeAxes(character.id, draft.axes, invalidValues);

    let name = character.name;
    const displayName = typeof draft.displayName === 'string' ? draft.displayName.trim() : '';
    if (displayName !== '' && displayName !== character.name) {
      nameChanges.push({ id: character.id, from: character.name, to: displayName, note: draft.nameNote ?? '' });
      name = displayName;
    }

    const aliases = normalizeAliases(draft.aliases, name);
    const dlsiteQuery = draft.dlsiteQuery === '' || draft.dlsiteQuery === undefined ? null : draft.dlsiteQuery;
    // hitomiCharacterが空/未設定ならhitomi.la収集の対象外とし、schema.tsのnull=対象外の
    // 意味をそのまま使う（空文字のcharacterを持つhitomiQueryは許容されない）。
    const hitomiQuery = draft.hitomiCharacter ? { character: draft.hitomiCharacter, series: null } : null;

    nextCharacters.push({ ...character, name, aliases, dlsiteQuery, hitomiQuery, axes });
    appliedCount += 1;

    for (const [axis, confidence] of Object.entries(draft.confidence ?? {})) {
      if (confidenceByAxis[axis] && (confidence === 'high' || confidence === 'medium' || confidence === 'low')) {
        confidenceByAxis[axis][confidence] += 1;
      }
    }
    for (const [axis, basis] of Object.entries(draft.basis ?? {})) {
      if (basisByAxis[axis]) basisByAxis[axis][basis] = (basisByAxis[axis][basis] ?? 0) + 1;
    }

    const failure = checkRequiredAndOptional(character.id, axes);
    if (failure) a4a11Failures.push(failure);
  }

  for (const { id } of excluded) {
    delete overridesFile.overrides[id];
    delete niconicoMap.entries[id];
    delete llmExtract.entries[id];
  }

  if (!dryRun) {
    writeJson(charactersPath, nextCharacters);
    writeJson(overridesPath, overridesFile);
    writeJson(niconicoMapPath, niconicoMap);
    writeJson(llmExtractPath, llmExtract);
  }

  const stateDir = fileURLToPath(new URL('../../state/expansion/', import.meta.url));
  mkdirSync(stateDir, { recursive: true });
  const reportPath = join(stateDir, 'apply-report.json');
  const report = {
    generatedAt: new Date().toISOString(),
    journalPath,
    dataDir,
    dryRun,
    summary: {
      targetsTotal,
      applied: appliedCount,
      excluded: excluded.length,
      missingDrafts: missingDrafts.length,
      nameChanges: nameChanges.length,
      invalidValues: invalidValues.length,
      a4a11Failures: a4a11Failures.length,
    },
    missingDrafts,
    excluded,
    nameChanges,
    invalidValues,
    a4a11Failures,
    confidenceByAxis,
    basisByAxis,
  };
  writeJson(reportPath, report);

  console.log(`対象(新規キャラ): ${targetsTotal} 件`);
  console.log(`適用: ${appliedCount} 件`);
  console.log(`除外(flags): ${excluded.length} 件`);
  console.log(`下書きなし: ${missingDrafts.length} 件`);
  console.log(`name変更: ${nameChanges.length} 件`);
  console.log(`語彙外の値(破棄): ${invalidValues.length} 件`);
  console.log(`A4/A11相当の不足: ${a4a11Failures.length} 件`);
  console.log(dryRun ? '[dry-run] データファイルへの書き込みはしていません。' : `data/ 配下4ファイルに書き込みました（${dataDir}）。`);
  console.log(`レポート: ${reportPath}`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
