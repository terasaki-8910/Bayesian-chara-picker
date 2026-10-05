#!/usr/bin/env node
/**
 * Danbooru の投稿キャッシュ（state/bayes-pipeline/danbooru/<id>.json）から、品質ゲート
 * （tests/quality-gates.test.ts）が使う「タグの出現数」だけを数値で書き出す。
 *
 *   node scripts/bayes/export-danbooru-stats.mjs [--state-dir <state ディレクトリ>] [--out <出力先>]
 *
 * なぜ書き出すのか:
 *   state/ は gitignore で、PC ごとに中身が違う。テストが state/ を直接読むと「PC によって
 *   結果が変わる・キャッシュが無い PC では検証できない」ので、必要な数値だけをここで取り出して
 *   data/bayes/danbooru-stats.json にコミットし、テストはそれだけを読む。
 *
 * 書き出す物（数値のみ。記事の本文のような文章・投稿 ID・投稿ごとのタグ列は入れない）:
 *   - solo タグの付いた投稿だけを数える（複数キャラの絵の髪色・肌色が混ざるのを避けるため。
 *     solo 以外の投稿のタグはキャラ本人の特徴を表さない）。
 *   - soloPosts: solo 投稿の件数
 *   - counts: 対象タグごとの solo 投稿内の出現数（0 のタグは省く＝無ければ 0）
 *   - hairPosts / bustPosts: 髪色・胸サイズのグループのタグを 1 つ以上持つ solo 投稿の件数
 *     （「髪色タグが付いた投稿のうち何割がその色か」という割合の分母。Danbooru では髪色を
 *     書かない投稿も多いため、全投稿を分母にすると割合が小さく出てしまう）
 *
 * 対象タグは、パイプライン自身の語彙（data/bayes/questions.json の groups）を使う。
 * 髪色・胸サイズはそのグループのタグ、残りは下の SINGLE_TAGS。ここに足したタグだけが
 * テストから使える。
 *
 * state/ は読み取り専用で扱う（書き込まない）。--state-dir は state ディレクトリそのもの
 * （その下の bayes-pipeline/danbooru/ を読む）。環境変数 BAYES_STATE_DIR でも指定できる。
 * 既定はこのリポジトリの state/。別の作業ツリーから、元の作業ツリーの state/ を指して
 * 実行する使い方を想定している。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_OUT = path.join(REPO_ROOT, 'data/bayes/danbooru-stats.json');

/** グループ以外に数えるタグ。品質ゲートのルールが参照する物だけを置く。 */
export const SINGLE_TAGS = ['dark_skin', 'tan', 'animal_ears', 'tail', 'long_hair'];

/** 髪色・胸サイズのグループ名（questions.json の groups のキー）→ 出力上の名前。 */
export const GROUPS = { hairColor: 'hair-color', bust: 'breast-size' };

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * 1 キャラ分の投稿（{id, tags}[]）から、solo 投稿の集計を作る。純関数（テスト可能）。
 * @param {{ tags: string[] }[]} posts
 * @param {Record<string, string[]>} groups 出力上のグループ名 → タグ列
 * @param {string[]} singleTags
 */
export function summarizePosts(posts, groups, singleTags) {
  const solo = posts.filter((p) => p.tags.includes('solo'));
  const groupTags = new Set(Object.values(groups).flat());
  const wanted = new Set([...groupTags, ...singleTags]);
  /** @type {Record<string, number>} */
  const tally = {};
  const groupPosts = Object.fromEntries(Object.keys(groups).map((g) => [g, 0]));
  for (const p of solo) {
    for (const t of p.tags) if (wanted.has(t)) tally[t] = (tally[t] ?? 0) + 1;
    for (const [g, tags] of Object.entries(groups)) {
      if (tags.some((t) => p.tags.includes(t))) groupPosts[g] += 1;
    }
  }
  const counts = Object.fromEntries(Object.entries(tally).sort(([a], [b]) => a.localeCompare(b)));
  return { soloPosts: solo.length, hairPosts: groupPosts.hairColor, bustPosts: groupPosts.bust, counts };
}

/**
 * @param {{ stateDir: string, repoRoot?: string }} opts
 */
export function buildStats({ stateDir, repoRoot = REPO_ROOT }) {
  const dir = path.join(stateDir, 'bayes-pipeline', 'danbooru');
  if (!existsSync(dir)) throw new Error(`Danbooru キャッシュのディレクトリが無い: ${dir}`);
  const characters = readJson(path.join(repoRoot, 'data/characters.json'));
  const tagMap = readJson(path.join(repoRoot, 'data/bayes/tag-map.json')).entries;
  const questions = readJson(path.join(repoRoot, 'data/bayes/questions.json'));
  const groups = Object.fromEntries(
    Object.entries(GROUPS).map(([out, name]) => {
      const g = questions.groups[name];
      if (!g) throw new Error(`questions.json に groups.${name} が無い`);
      return [out, [...g.coverageTags]];
    }),
  );

  /** @type {Record<string, unknown>} */
  const entries = {};
  const skipped = [];
  for (const c of characters) {
    const file = path.join(dir, `${c.id}.json`);
    if (!existsSync(file)) {
      skipped.push(`${c.id}: キャッシュ無し`);
      continue;
    }
    const cache = readJson(file);
    if (!Array.isArray(cache.posts)) {
      skipped.push(`${c.id}: posts が配列でない（取得途中の壊れたキャッシュ）`);
      continue;
    }
    // キャッシュ取得後にタグの対応付けが変わったキャラは、別キャラの統計を書き出さない。
    const mapped = tagMap[c.id]?.tag ?? null;
    if (cache.tag !== mapped) {
      skipped.push(`${c.id}: キャッシュのタグ(${cache.tag})が tag-map(${mapped})と違う`);
      continue;
    }
    entries[c.id] = {
      tag: cache.tag,
      fetchedAt: String(cache.fetchedAt ?? '').slice(0, 10),
      ...summarizePosts(cache.posts, groups, SINGLE_TAGS),
    };
  }
  const stats = {
    version: 1,
    note:
      'Danbooru キャッシュ(state/bayes-pipeline/danbooru)の solo 投稿から数えたタグの出現数。数値のみ。' +
      '生成: node scripts/bayes/export-danbooru-stats.mjs --state-dir <state>。手で編集しない。',
    groups,
    singleTags: SINGLE_TAGS,
    entries,
  };
  return { stats, skipped };
}

/** 1 キャラ 1 行にして差分を読みやすくする（それ以外は通常の整形）。 */
export function serialize(stats) {
  const { entries, ...rest } = stats;
  const head = JSON.stringify(rest, null, 1).replace(/\n}$/, '');
  const rows = Object.entries(entries).map(([id, e]) => `  ${JSON.stringify(id)}: ${JSON.stringify(e)}`);
  return `${head},\n "entries": {\n${rows.join(',\n')}\n }\n}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const stateDir = path.resolve(arg('--state-dir') ?? process.env.BAYES_STATE_DIR ?? path.join(REPO_ROOT, 'state'));
  const out = path.resolve(arg('--out') ?? DEFAULT_OUT);
  const { stats, skipped } = buildStats({ stateDir });
  writeFileSync(out, serialize(stats));
  console.log(`書き出し: ${Object.keys(stats.entries).length} 体 → ${out}`);
  if (skipped.length > 0) {
    console.log(`除外 ${skipped.length} 体:`);
    for (const s of skipped) console.log(`  ${s}`);
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) main();
