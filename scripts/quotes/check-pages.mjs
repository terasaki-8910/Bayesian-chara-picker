#!/usr/bin/env node
/**
 * 名台詞: 査読の一覧の候補について、出どころのページの本文に台詞がそのまま載っているかを確かめる。
 *
 *   node scripts/quotes/check-pages.mjs --dir state/quotes/draft/pass3
 *
 * --dir の review-input.json（apply.mjs --review-out の出力）を読み、次の2つを書く。
 *   review-input.json  自動で落とした候補を除き、各候補に page（本文の様子と、台詞の前後の抜粋）を足したもの
 *   review-auto.json   本文を読めたのに台詞が無かった候補の答え（reject）。査読の答えと合わせて apply.mjs に渡す
 * 元の一覧は review-input.raw.json に残す（2回目以降はそちらから読む）。
 *
 * page.status:
 *   match       本文に台詞がある（句読点・記号・空白の違いは無視）
 *   nomatch     本文を読めて、キャラの名前も載っているのに、台詞が無い → 自動で reject
 *   unreadable  本文が短い・名前が載っていない（スクリプトで描くページなど）→ 査読に回す
 *   blocked     robots.txt が取得を禁じている → 取らずに査読に回す
 *   error       取れなかった（HTTP の誤り・時間切れ）→ 査読に回す
 * 出どころが複数あるときは、いちばん良い結果を採る。ページの取り方は pages.mjs。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ROOT, loose, looseWithMap, namesOf, readPage } from './pages.mjs';

const MIN_TEXT = 1000;
const CONTEXT = 120;
const RANK = { match: 5, nomatch: 4, unreadable: 3, error: 2, blocked: 1 };

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function parseArgs(argv) {
  const args = { dir: null };
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--dir') args.dir = argv[++i];
  if (!args.dir) throw new Error('--dir が要る');
  return args;
}

async function checkCandidate(c, names) {
  const results = [];
  for (const url of c.source) {
    const page = await readPage(url);
    if (page.status !== 'ok') {
      results.push({ status: page.status, url, ...(page.http ? { http: page.http } : {}) });
      continue;
    }
    const { out, map } = looseWithMap(page.text);
    const needle = loose(c.text);
    const at = needle ? out.indexOf(needle) : -1;
    if (at >= 0) {
      const start = map[at];
      const end = map[at + needle.length - 1] + 1;
      const context = page.text
        .slice(Math.max(0, start - CONTEXT), end + CONTEXT)
        .replace(/\s+/g, ' ')
        .trim();
      results.push({ status: 'match', url, context });
      continue;
    }
    const readable = out.length >= MIN_TEXT && names.some((n) => out.includes(loose(n)));
    results.push({ status: readable ? 'nomatch' : 'unreadable', url });
  }
  return results.sort((a, b) => RANK[b.status] - RANK[a.status])[0];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolve(ROOT, args.dir);
  const rawPath = join(dir, 'review-input.raw.json');
  if (!existsSync(rawPath)) writeFileSync(rawPath, readFileSync(join(dir, 'review-input.json')));
  const candidates = readJson(rawPath);
  const byId = new Map(readJson(join(ROOT, 'data/characters.json')).map((c) => [c.id, c]));

  const keep = [];
  const auto = [];
  const counts = {};
  for (const c of candidates) {
    const page = await checkCandidate(c, namesOf(byId.get(c.id)));
    counts[page.status] = (counts[page.status] ?? 0) + 1;
    if (page.status === 'nomatch') {
      auto.push({ rkey: c.rkey, decision: 'reject', reason: `ページの本文に台詞が無い（${page.url}）`, harsh: c.harsh });
    } else {
      keep.push({ ...c, page });
    }
  }
  writeFileSync(join(dir, 'review-input.json'), `${JSON.stringify(keep, null, 1)}\n`);
  writeFileSync(join(dir, 'review-auto.json'), `${JSON.stringify(auto, null, 1)}\n`);
  console.log(JSON.stringify({ candidates: candidates.length, review: keep.length, autoReject: auto.length, ...counts }));
}

await main();
