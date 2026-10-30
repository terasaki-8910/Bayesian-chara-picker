#!/usr/bin/env node
/**
 * 名台詞: 台詞が載っていそうなページを取ってきて、台詞の多い部分を抜き出し、本文から写す担当（luna）に渡す組を作る。
 *
 *   node scripts/quotes/page-excerpts.mjs --dir state/quotes/draft/pass3 --targets state/quotes/draft/pass3/targets.json
 *
 * 読むもの:
 *   --targets                 キャラの一覧（[{ id, name, aliases, series, rejected? }]）
 *   <dir>/web/lunau-*.out.json  ページ探しの結果（TASK-urls の形、[{ id, pages: [url] }]）
 *   ほかに、ページ名が決まっている wiki とニコニコ大百科の URL を作って足す（SERIES_PAGES）。
 * 書くもの:
 *   <dir>/web/lunax-XX.json   本文から写す担当の組（[{ id, name, aliases, series, rejected?, pages: [{ url, text }] }]）
 *   <dir>/excerpts-report.json  ページごとの取れ方
 *
 * 抜き出し方: 本文を一定の長さの窓に区切り、台詞の手がかり（ボイス一覧の見出し・台詞の節の見出し・「）が多い窓を、
 * 重ならないように1ページ3つまで採る。ページの取り方は pages.mjs（robots.txt に従い、控えを使う）。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ROOT, namesOf, readPage } from './pages.mjs';

const WINDOW = 3000;
const STEP = 500;
const WINDOWS_PER_PAGE = 3;
const PAGES_PER_CHARACTER = 4;
const CHUNK_CHARS = 60000;
// ボイス一覧の行の見出しと台詞の節の見出しを重く、かぎかっこを軽く見る。キャラ名は数えない
// （スキルや戦績の表にも名前が多く出て、ボイスの節から外れるため。2026-10-30 の試しで確かめた）。
const STRONG_CUES =
  /ボイス|セリフ|台詞|口癖|名言|自己紹介|秘書任命|会話[1-3１-３]|入手時?|ホーム|編成|戦闘開始|勝利|敗北|ログイン|タッチ|放置|昇進|信頼/g;
const QUOTE_MARK = /「/g;
// 台詞の節の見出し。見つかれば、そこから始まる窓を先に採る（wikiru の「クリックでセリフ一覧を開く」など）。
const ANCHORS = /セリフ一覧|ボイス一覧|台詞一覧|主な台詞|主なセリフ|名台詞|名言|口癖/g;
const BLOCKED_HOSTS = ['dic.pixiv.net', 'wiki.xn--rckteqa2e.com'];

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const e = encodeURIComponent;
/** ブルアカの wiki のページ名は名前の片仮名の部分（「一之瀬アスナ」→「アスナ」）。 */
const givenKana = (name) => name.match(/[ァ-ヴー]+$/)?.[0] ?? name;
/**
 * ページ名が決まっている wiki は、探さずに URL を作る（2026-10-30 に本文にボイスが載っていることを確かめたもの）。
 * ニコニコ大百科は全キャラに足す（記事が無ければ 404 で飛ばす）。
 */
const SERIES_PAGES = {
  アークナイツ: (c) => [`https://arknights.wikiru.jp/?${e(c.name)}`],
  ブルーアーカイブ: (c) => [`https://bluearchive.wikiru.jp/?${e(givenKana(c.name))}`],
  原神: (c) => [`https://wikiwiki.jp/genshinwiki/${e(c.name)}`],
  '崩壊：スターレイル': (c) => [`https://wikiwiki.jp/star-rail/${e(c.name)}`],
};
const seedPages = (c) => [...(SERIES_PAGES[c.series]?.(c) ?? []), `https://dic.nicovideo.jp/a/${e(c.name)}`];

function parseArgs(argv) {
  const args = { dir: null, targets: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--targets') args.targets = argv[++i];
  }
  if (!args.dir || !args.targets) throw new Error('--dir と --targets が要る');
  return args;
}

const count = (text, re) => (text.match(re) ?? []).length;

function excerpt(text) {
  if (text.length <= WINDOW * WINDOWS_PER_PAGE) return text;
  const scored = [];
  for (let at = 0; at < text.length; at += STEP) {
    const w = text.slice(at, at + WINDOW);
    scored.push({ at, score: 3 * count(w, STRONG_CUES) + count(w, QUOTE_MARK) });
  }
  for (const m of text.matchAll(ANCHORS)) scored.push({ at: Math.max(0, m.index - 100), score: Infinity });
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const s of scored) {
    if (picked.length >= WINDOWS_PER_PAGE || s.score === 0) break;
    if (picked.some((p) => Math.abs(p.at - s.at) < WINDOW)) continue;
    picked.push(s);
  }
  return picked
    .sort((a, b) => a.at - b.at)
    .map((p) => text.slice(p.at, p.at + WINDOW))
    .join('\n……\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolve(ROOT, args.dir);
  const webDir = join(dir, 'web');
  const targets = readJson(resolve(ROOT, args.targets));
  const found = new Map();
  for (const f of readdirSync(webDir).filter((f) => /^lunau-\d+\.out\.json$/.test(f)).sort()) {
    for (const row of readJson(join(webDir, f))) found.set(row.id, row.pages ?? []);
  }

  const rows = [];
  const report = [];
  for (const t of targets) {
    const fromSearch = (found.get(t.id) ?? [])
      .filter((u) => typeof u === 'string' && u.startsWith('https://') && !BLOCKED_HOSTS.includes(new URL(u).host))
      .slice(0, PAGES_PER_CHARACTER);
    const urls = [...new Set([...seedPages(t), ...fromSearch])];
    const names = namesOf(t);
    const pages = [];
    for (const url of urls) {
      const page = await readPage(url);
      report.push({ id: t.id, url, status: page.status, ...(page.http ? { http: page.http } : {}), length: page.text?.length ?? 0 });
      if (page.status !== 'ok' || !names.some((n) => page.text.includes(n))) continue;
      pages.push({ url, text: excerpt(page.text) });
    }
    if (pages.length) rows.push({ ...t, pages });
  }

  let chunk = [];
  let size = 0;
  let n = 0;
  const flush = () => {
    if (!chunk.length) return;
    n += 1;
    writeFileSync(join(webDir, `lunax-${String(n).padStart(2, '0')}.json`), `${JSON.stringify(chunk, null, 1)}\n`);
    chunk = [];
    size = 0;
  };
  for (const r of rows) {
    const s = r.pages.reduce((a, p) => a + p.text.length, 0);
    if (size + s > CHUNK_CHARS) flush();
    chunk.push(r);
    size += s;
  }
  flush();
  writeFileSync(join(dir, 'excerpts-report.json'), `${JSON.stringify(report, null, 1)}\n`);
  const byStatus = {};
  for (const r of report) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  console.log(JSON.stringify({ targets: targets.length, withPages: rows.length, chunks: n, pages: report.length, ...byStatus }));
}

await main();
