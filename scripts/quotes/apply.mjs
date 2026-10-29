#!/usr/bin/env node
/**
 * 名台詞: 下書き・Web の確かめ・Web の探索・Opus の査読を合わせて、data/quotes.json に入れる（R13）。
 *
 * 2段で使う。
 *   1. 査読の一覧を作る（データは変えない）
 *        node scripts/quotes/apply.mjs --dir state/quotes/draft/houfu --review-out state/quotes/draft/houfu/review-input.json
 *      Web の結果（verified / corrected / 探索で見つけた台詞）を、出どころの抜粋付きで並べる。
 *   2. 査読の答えを合わせて入れる
 *        node scripts/quotes/apply.mjs --dir state/quotes/draft/houfu --review state/quotes/draft/houfu/review.json [--dry-run]
 *
 * --dir の中で読むもの:
 *   collected.json                   collect-drafts.mjs の出力（下書きの台詞と、抜き取ったかどうか）
 *   web/verify-*.out.json, web/luna-*.out.json   確かめの結果（TASK-verify の形、key で下書きと結ぶ）
 *     同じ候補に複数の結果があるときは、verified / corrected を not_found より優先する
 *     （検索の上限で調べきれなかった候補を、別の担当で調べ直すため）。
 *   web/search-*.out.json, web/lunas-*.out.json  探索の結果（TASK-search の形）
 * 査読の答え（review.json）は [{ rkey, decision: "accept" | "reject", reason, harsh? }]。一覧の全件に答えが要る。
 *
 * 入れ方:
 *   - 抜き取った high のうち、言い回しまで同じ（verified）だった率が 95% 未満なら、抜き取り外の high は入れない
 *     （その帯の high を全部確かめる。R13-1）。95% 以上なら、抜き取り外の high を checked: "memory" で入れる。
 *   - 確かめの verified / corrected と探索の台詞は、査読で accept のものだけ入れる。
 *   - 1体3個まで。すでに入っている台詞を先に残し、確かめた下書き → 記憶だけの下書き → 探索の順に足す。
 *   - 入れなかった台詞は state 側の apply-report.json に理由付きで残す（data/quotes.json には入れない）。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MAX_LENGTH = 60;
const MAX_PER_CHARACTER = 3;
const SAMPLE_PASS_RATE = 0.95;

function parseArgs(argv) {
  const args = { dir: null, reviewOut: null, review: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--review-out') args.reviewOut = argv[++i];
    else if (argv[i] === '--review') args.review = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  if (!args.dir) throw new Error('--dir が要る');
  if (!args.reviewOut === !args.review) throw new Error('--review-out か --review のどちらか1つ');
  return args;
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
/** 句読点・記号・長音の揺れを除いて比べる。 */
const loose = (s) => String(s ?? '').normalize('NFKC').replace(/[\s!?！？…‥・.,、。〜~ー\-—―☆\u266A「」『』]/g, '');
const clean = (s) => String(s ?? '').trim().normalize('NFC');
const okText = (t) => t && [...t].length <= MAX_LENGTH && !/[「」\r\n]/.test(t);
const httpsOnly = (list) => (Array.isArray(list) ? list : []).filter((u) => typeof u === 'string' && u.startsWith('https://'));

function readOuts(webDir, pattern) {
  if (!existsSync(webDir)) return [];
  return readdirSync(webDir)
    .filter((f) => pattern.test(f))
    .sort()
    .flatMap((f) => readJson(join(webDir, f)));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolve(ROOT, args.dir);
  const webDir = join(dir, 'web');
  const characters = readJson(join(ROOT, 'data/characters.json'));
  const byId = new Map(characters.map((c) => [c.id, c]));
  const quotesPath = join(ROOT, 'data/quotes.json');
  const quotes = readJson(quotesPath);
  const collected = readJson(join(dir, 'collected.json'));
  const draftByKey = new Map(collected.map((q) => [`${q.id}#${q.text}`, q]));

  const STATUS_RANK = { verified: 3, corrected: 3, wrong_character: 2, not_found: 1 };
  const verifyResults = new Map();
  for (const r of readOuts(webDir, /^(verify|luna)-\d+\.out\.json$/)) {
    const prev = verifyResults.get(r.key);
    if (!prev || (STATUS_RANK[r.status] ?? 0) > (STATUS_RANK[prev.status] ?? 0)) verifyResults.set(r.key, r);
  }
  const searchRows = readOuts(webDir, /^(search|lunas)-\d+\.out\.json$/);

  // 抜き取りの判定（R13-1）。
  const sampled = collected.filter((q) => q.confidence === 'high' && q.sampled);
  const sampleChecked = sampled.filter((q) => verifyResults.has(`${q.id}#${q.text}`));
  const sampleSame = sampleChecked.filter((q) => {
    const r = verifyResults.get(`${q.id}#${q.text}`);
    return r.status === 'verified' && loose(r.text || q.text) === loose(q.text);
  });
  const sampleRate = sampleChecked.length ? sampleSame.length / sampleChecked.length : null;
  const sampleDone = sampleChecked.length === sampled.length;
  const memoryAllowed = sampleDone && sampleRate !== null && sampleRate >= SAMPLE_PASS_RATE;

  // 査読にかける候補（Web の結果）。
  const candidates = [];
  const rejected = [];
  for (const [key, r] of verifyResults) {
    const draft = draftByKey.get(key);
    const id = draft?.id ?? key.split('#')[0];
    if (!byId.has(id)) {
      rejected.push({ key, reason: '収録に無い id' });
      continue;
    }
    if (r.status !== 'verified' && r.status !== 'corrected') {
      rejected.push({ key, reason: `確かめ: ${r.status}${r.speaker ? `（${r.speaker}）` : ''}` });
      continue;
    }
    const text = clean(r.status === 'corrected' ? r.text : r.text || draft?.text || key.slice(id.length + 1));
    const source = httpsOnly(r.source);
    if (!okText(text) || source.length === 0) {
      rejected.push({ key, reason: !okText(text) ? `決まりに合わない: ${text}` : '出どころの https の URL が無い' });
      continue;
    }
    candidates.push({
      rkey: key,
      id,
      name: byId.get(id).name,
      series: byId.get(id).series,
      origin: r.status,
      original: draft?.text ?? key.slice(id.length + 1),
      text,
      where: draft?.where ?? '',
      source,
      evidence: String(r.evidence ?? ''),
      harsh: draft?.harsh === true,
      fromDraft: Boolean(draft),
    });
  }
  for (const row of searchRows) {
    if (!byId.has(row.id)) continue;
    for (const q of row.quotes ?? []) {
      const text = clean(q.text);
      const source = httpsOnly(q.source);
      const rkey = `${row.id}#S#${text}`;
      if (!okText(text) || source.length === 0) {
        rejected.push({ key: rkey, reason: !okText(text) ? `決まりに合わない: ${text}` : '出どころの https の URL が無い' });
        continue;
      }
      candidates.push({
        rkey,
        id: row.id,
        name: byId.get(row.id).name,
        series: byId.get(row.id).series,
        origin: 'search',
        original: '',
        text,
        where: String(q.where ?? ''),
        source,
        evidence: String(q.evidence ?? ''),
        harsh: q.harsh === true,
        fromDraft: false,
      });
    }
  }

  if (args.reviewOut) {
    writeFileSync(resolve(ROOT, args.reviewOut), `${JSON.stringify(candidates, null, 1)}\n`);
    console.log(JSON.stringify({ candidates: candidates.length, rejected: rejected.length, sampleChecked: sampleChecked.length, sampled: sampled.length, sampleRate, memoryAllowed }));
    return;
  }

  const review = new Map(readJson(resolve(ROOT, args.review)).map((d) => [d.rkey, d]));
  const unanswered = candidates.filter((c) => !review.has(c.rkey)).map((c) => c.rkey);
  if (unanswered.length) throw new Error(`査読の答えが無い候補が ${unanswered.length} 件: ${unanswered.slice(0, 5).join(', ')}`);

  const additions = new Map();
  const push = (id, entry, tag) => {
    if (!additions.has(id)) additions.set(id, []);
    additions.get(id).push({ entry, tag });
  };
  for (const c of candidates) {
    const d = review.get(c.rkey);
    if (d.decision !== 'accept') {
      rejected.push({ key: c.rkey, reason: `査読: ${d.reason ?? 'reject'}` });
      continue;
    }
    const harsh = typeof d.harsh === 'boolean' ? d.harsh : c.harsh;
    const checked = c.origin === 'corrected' ? 'corrected' : 'verified';
    push(c.id, { text: c.text, source: c.source, checked, ...(harsh ? { harsh: true } : {}) }, c.fromDraft ? 0 : 2);
  }
  const memoryHeld = [];
  for (const q of collected) {
    if (q.confidence !== 'high' || q.sampled) continue;
    if (!memoryAllowed) {
      memoryHeld.push(`${q.id}#${q.text}`);
      continue;
    }
    push(q.id, { text: q.text, source: [], checked: 'memory', ...(q.harsh ? { harsh: true } : {}) }, 1);
  }

  let added = 0;
  const overflow = [];
  for (const [id, list] of additions) {
    const current = quotes.characters[id] ? [...quotes.characters[id]] : [];
    list.sort((a, b) => a.tag - b.tag);
    for (const { entry } of list) {
      if (current.some((q) => loose(q.text) === loose(entry.text))) continue;
      if (current.length >= MAX_PER_CHARACTER) {
        overflow.push(`${id}#${entry.text}`);
        continue;
      }
      current.push(entry);
      added++;
    }
    if (current.length) quotes.characters[id] = current;
  }
  quotes.characters = Object.fromEntries(Object.entries(quotes.characters).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  const report = {
    sampled: sampled.length,
    sampleChecked: sampleChecked.length,
    sampleSame: sampleSame.length,
    sampleRate,
    memoryAllowed,
    memoryHeld,
    candidates: candidates.length,
    added,
    overflow,
    rejected,
    characters: Object.keys(quotes.characters).length,
    quotes: Object.values(quotes.characters).reduce((n, l) => n + l.length, 0),
  };
  writeFileSync(join(dir, 'apply-report.json'), `${JSON.stringify(report, null, 1)}\n`);
  if (!args.dryRun) writeFileSync(quotesPath, `${JSON.stringify(quotes, null, 2)}\n`);
  const { rejected: r, memoryHeld: m, overflow: o, ...counts } = report;
  console.log(JSON.stringify({ ...counts, rejected: r.length, memoryHeld: m.length, overflow: o.length, dryRun: args.dryRun }));
}

main();
