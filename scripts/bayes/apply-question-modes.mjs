#!/usr/bin/env node
/**
 * data/bayes/question-modes.json（遊び方ごとの質問の手書きデータ）を、
 * data/bayes/questions.runtime.json の各質問の `modes` 欄に写す（R14）。
 *
 * question-modes.json は questions.json の質問id（dg:hair-color:black_hair 等）で引く。
 * 実行時の key（q001..）は questions.json の並び順の連番なので、順番で対応させる
 * （build-likelihoods.mjs が同じ順で key を振る）。key・prompt・reason は変えない。
 *
 * runtime の modes の形（どちらの遊び方も、書くことがなければ省く）:
 *   { guess?: { skip?: true }, discover?: { prompt?: string, skip?: true, group?: string } }
 *
 * build-likelihoods.mjs も runtime を書き出すときに attachQuestionModes() を使うので、
 * 尤度を作り直しても modes は消えない。likelihoods.json は触らない。
 * 通信なし・決定論。
 *
 *   node scripts/bayes/apply-question-modes.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** questions.json の i 番目（0始まり）の質問の、実行時の不透明な key。 */
export function runtimeKeyOf(index) {
  return `q${String(index + 1).padStart(3, '0')}`;
}

const MODE_FIELDS = {
  guess: ['skip'],
  discover: ['prompt', 'skip', 'group'],
};

/** question-modes.json の1問ぶんを検査し、runtime の modes の形（キー順は固定）に整える。書くことがなければ undefined。 */
function normalizeModes(id, entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`question-modes.json: ${id} の値がオブジェクトではありません`);
  }
  const unknownMode = Object.keys(entry).filter((mode) => !(mode in MODE_FIELDS));
  if (unknownMode.length > 0) {
    throw new Error(`question-modes.json: ${id} に未知の遊び方があります: ${unknownMode.join(', ')}`);
  }
  const modes = {};
  for (const [mode, fields] of Object.entries(MODE_FIELDS)) {
    const value = entry[mode];
    if (value === undefined) continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`question-modes.json: ${id}.${mode} がオブジェクトではありません`);
    }
    const unknownField = Object.keys(value).filter((f) => !fields.includes(f));
    if (unknownField.length > 0) {
      throw new Error(`question-modes.json: ${id}.${mode} に未知の欄があります: ${unknownField.join(', ')}`);
    }
    const out = {};
    for (const f of fields) {
      if (value[f] === undefined) continue;
      if (f === 'skip' ? value[f] !== true : typeof value[f] !== 'string' || value[f] === '') {
        throw new Error(`question-modes.json: ${id}.${mode}.${f} の値が不正です: ${JSON.stringify(value[f])}`);
      }
      out[f] = value[f];
    }
    if (Object.keys(out).length > 0) modes[mode] = out;
  }
  return Object.keys(modes).length > 0 ? modes : undefined;
}

/**
 * runtime の質問配列（questions.json と同じ並び順）に `modes` 欄を足した新しい配列を返す。
 * 元の modes があれば捨てて付け直す。id が questions.json と question-modes.json の片方にしか無ければ投げる。
 *
 * @param {{ key: string, prompt: string, reason: object }[]} runtimeQuestions
 * @param {{ questions: { id: string }[] }} questionsFile
 * @param {{ questions: Record<string, object> }} modesFile
 */
export function attachQuestionModes(runtimeQuestions, questionsFile, modesFile) {
  const ids = questionsFile.questions.map((q) => q.id);
  if (runtimeQuestions.length !== ids.length) {
    throw new Error(`questions.runtime.json の質問数(${runtimeQuestions.length})が questions.json(${ids.length})と違います`);
  }
  runtimeQuestions.forEach((q, i) => {
    if (q.key !== runtimeKeyOf(i)) {
      throw new Error(`questions.runtime.json の ${i + 1} 番目の key が ${runtimeKeyOf(i)} ではありません: ${q.key}`);
    }
  });
  if (modesFile?.questions === null || typeof modesFile?.questions !== 'object') {
    throw new Error('question-modes.json に questions がありません');
  }
  const idSet = new Set(ids);
  const modeIds = Object.keys(modesFile.questions);
  const onlyInModes = modeIds.filter((id) => !idSet.has(id));
  const onlyInQuestions = ids.filter((id) => !(id in modesFile.questions));
  if (onlyInModes.length > 0 || onlyInQuestions.length > 0) {
    throw new Error(
      [
        'question-modes.json と questions.json の質問id が一致しません。',
        ...(onlyInModes.length > 0 ? [`  question-modes.json にだけある: ${onlyInModes.join(', ')}`] : []),
        ...(onlyInQuestions.length > 0 ? [`  questions.json にだけある: ${onlyInQuestions.join(', ')}`] : []),
      ].join('\n'),
    );
  }
  return runtimeQuestions.map((q, i) => {
    const { modes: _old, ...rest } = q;
    const modes = normalizeModes(ids[i], modesFile.questions[ids[i]]);
    return modes === undefined ? rest : { ...rest, modes };
  });
}

function main() {
  const dir = new URL('../../data/bayes/', import.meta.url);
  const read = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(name, dir)), 'utf8'));
  const questionsFile = read('questions.json');
  const modesFile = read('question-modes.json');
  const runtime = read('questions.runtime.json');

  const next = { ...runtime, questions: attachQuestionModes(runtime.questions, questionsFile, modesFile) };
  writeFileSync(fileURLToPath(new URL('questions.runtime.json', dir)), `${JSON.stringify(next, null, 2)}\n`);

  const count = (pick) => next.questions.filter((q) => pick(q.modes ?? {})).length;
  console.log(`完了。${next.questions.length}問の modes を data/bayes/questions.runtime.json に書き込みました。`);
  console.log(`  当てるで聞かない: ${count((m) => m.guess?.skip === true)}問`);
  console.log(`  探すで聞かない: ${count((m) => m.discover?.skip === true)}問`);
  console.log(`  探すの文: ${count((m) => m.discover?.prompt !== undefined)}問 / 細かい見た目(detail): ${count((m) => m.discover?.group === 'detail')}問`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
