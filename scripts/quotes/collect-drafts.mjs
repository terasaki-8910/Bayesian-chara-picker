#!/usr/bin/env node
/**
 * 名台詞: 記憶で書いた下書き（batch-XX.draft.json）を集め、次の段の一覧を作る（R13-1）。
 *
 * 出力（--dir の中）:
 *   collected.json     下書きの全台詞（形を確かめ、既存と同じ台詞・決まりに合わない台詞を除いたもの）
 *   verify-queue.json  Web で確かめる台詞: medium の全部と、high から抜き取った --sample 個（seed 付きで再現できる）
 *   search-queue.json  台詞が1つも無いキャラ（data/quotes.json と下書きの両方で0個）
 *   collect-report.json 除いた台詞とその理由、数の内訳
 *
 * 抜き取り外の high は、確かめずに checked: "memory" で入れる候補になる（入れるのは apply.mjs）。
 * --extra に JSON 配列（{ id, text }）を渡すと、確かめ直す種の台詞として verify-queue に足す。
 *
 * 使い方:
 *   node scripts/quotes/collect-drafts.mjs --dir state/quotes/draft/houfu [--sample 40] [--seed 13] [--extra state/quotes/pending-seed.json]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MAX_LENGTH = 60;
const MAX_PER_CHARACTER = 3;

function parseArgs(argv) {
  const args = { dir: null, sample: 40, seed: 13, extra: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--sample') args.sample = Number(argv[++i]);
    else if (argv[i] === '--seed') args.seed = Number(argv[++i]);
    else if (argv[i] === '--extra') args.extra = argv[++i];
  }
  if (!args.dir) throw new Error('--dir が要る');
  return args;
}

/** src/engine の mulberry32 と同じ乱数（抜き取りを再現できるようにする）。 */
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

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
/** 句読点・記号・長音の揺れを除いて比べる（同じ台詞の重なりを見つけるため）。 */
const loose = (s) => s.normalize('NFKC').replace(/[\s!?！？…‥・.,、。〜~ー\-—―☆\u266A「」『』]/g, '');

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolve(ROOT, args.dir);
  const characters = readJson(join(ROOT, 'data/characters.json'));
  const byId = new Map(characters.map((c) => [c.id, c]));
  const quotes = readJson(join(ROOT, 'data/quotes.json'));

  const inputs = readdirSync(dir).filter((f) => /^batch-\d+\.input\.json$/.test(f)).sort();
  const collected = [];
  const dropped = [];
  const missingBatches = [];
  const tierIds = [];

  for (const inputName of inputs) {
    const input = readJson(join(dir, inputName));
    const draftPath = join(dir, inputName.replace('.input.json', '.draft.json'));
    for (const c of input) tierIds.push(c.id);
    if (!existsSync(draftPath)) {
      missingBatches.push(inputName);
      continue;
    }
    const allowed = new Set(input.map((c) => c.id));
    const seenIds = new Set();
    for (const row of readJson(draftPath)) {
      if (!allowed.has(row.id)) {
        dropped.push({ id: row.id, reason: `${inputName} の組に無い id` });
        continue;
      }
      seenIds.add(row.id);
      const existing = (quotes.characters[row.id] ?? []).map((q) => loose(q.text));
      const kept = [];
      for (const q of row.quotes ?? []) {
        const text = String(q.text ?? '').trim().normalize('NFC');
        const why = !text
          ? '空'
          : [...text].length > MAX_LENGTH
            ? `${[...text].length}字`
            : /[「」\r\n]/.test(text)
              ? '「」か改行を含む'
              : !['high', 'medium'].includes(q.confidence)
                ? `confidence が ${q.confidence}`
                : existing.includes(loose(text)) || kept.some((k) => loose(k.text) === loose(text))
                  ? '既存と同じ'
                  : existing.length + kept.length >= MAX_PER_CHARACTER
                    ? '3個を超える'
                    : null;
        if (why) {
          dropped.push({ id: row.id, text, reason: why });
          continue;
        }
        kept.push({ text, confidence: q.confidence, where: String(q.where ?? ''), harsh: q.harsh === true });
      }
      for (const q of kept) collected.push({ id: row.id, ...q });
    }
    for (const id of allowed) if (!seenIds.has(id)) dropped.push({ id, reason: `${inputName} の下書きに行が無い` });
  }

  const key = (q) => `${q.id}#${q.text}`;
  const describe = (q) => {
    const c = byId.get(q.id);
    return { key: key(q), id: q.id, name: c.name, series: c.series, text: q.text, confidence: q.confidence, where: q.where };
  };

  const high = collected.filter((q) => q.confidence === 'high');
  const rand = mulberry32(args.seed);
  const shuffled = high.map((q) => [rand(), q]).sort((a, b) => a[0] - b[0]).map(([, q]) => q);
  const sample = shuffled.slice(0, Math.min(args.sample, high.length));
  const sampleKeys = new Set(sample.map(key));

  const verify = [
    ...collected.filter((q) => q.confidence === 'medium').map((q) => ({ ...describe(q), reason: 'medium' })),
    ...sample.map((q) => ({ ...describe(q), reason: 'sample' })),
  ];
  if (args.extra) {
    for (const e of readJson(resolve(ROOT, args.extra))) {
      if (!tierIds.includes(e.id)) continue;
      const c = byId.get(e.id);
      verify.push({ key: `${e.id}#${e.text}`, id: e.id, name: c.name, series: c.series, text: e.text, confidence: 'medium', where: '', reason: 'seed-recheck' });
    }
  }

  const withQuotes = new Set([...collected.map((q) => q.id), ...Object.keys(quotes.characters)]);
  const search = tierIds
    .filter((id) => !withQuotes.has(id))
    .map((id) => {
      const c = byId.get(id);
      return { id, name: c.name, aliases: c.aliases ?? [], series: c.series };
    });

  const report = {
    batches: inputs.length,
    missingBatches,
    characters: tierIds.length,
    collected: collected.length,
    high: high.length,
    medium: collected.length - high.length,
    sampled: sample.length,
    unsampledHigh: high.length - sample.length,
    verify: verify.length,
    search: search.length,
    harsh: collected.filter((q) => q.harsh).length,
    dropped,
  };
  writeFileSync(join(dir, 'collected.json'), `${JSON.stringify(collected.map((q) => ({ ...q, sampled: sampleKeys.has(key(q)) })), null, 1)}\n`);
  writeFileSync(join(dir, 'verify-queue.json'), `${JSON.stringify(verify, null, 1)}\n`);
  writeFileSync(join(dir, 'search-queue.json'), `${JSON.stringify(search, null, 1)}\n`);
  writeFileSync(join(dir, 'collect-report.json'), `${JSON.stringify(report, null, 1)}\n`);
  const { dropped: _d, ...counts } = report;
  console.log(JSON.stringify({ ...counts, dropped: dropped.length }));
}

main();
