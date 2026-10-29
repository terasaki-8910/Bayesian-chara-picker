#!/usr/bin/env node
/**
 * 名台詞: 供給量の帯ごとに、記憶で書く担当へ渡す組を作る（R13-2）。
 *
 * 同じ作品のキャラは同じ組に入れる（作品の知識で思い出しやすいため）。大きい作品から順に、
 * いちばん軽い組へ入れていく。1作品が1組の目安を超えるときだけ分ける。
 * data/quotes.json にすでにある台詞は existing として渡し、重ならないようにする。
 *
 * 使い方:
 *   node scripts/quotes/make-batches.mjs --tier 豊富 --batches 8 --out state/quotes/draft/houfu
 *
 * 帯は src/engine/supply.ts と同じ閾値で、DLsite と hitomi の高いほう（combinedRankFor と同じ）。
 * 男性・仮登録のキャラも、その帯に入れる（推測・結果の画面に出ることがあるため）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const RANKS = ['なし', '僅少', '少ない', '十分', '豊富'];

// src/engine/supply.ts の supplyRank / hitomiSupplyRank と同じ閾値。
function dlsiteRank(pageCount) {
  if (pageCount <= 0) return 0;
  if (pageCount === 1) return 1;
  if (pageCount <= 5) return 2;
  if (pageCount <= 20) return 3;
  return 4;
}
function hitomiRank(galleryCount) {
  if (galleryCount <= 0) return 0;
  if (galleryCount <= 10) return 1;
  if (galleryCount <= 50) return 2;
  if (galleryCount <= 200) return 3;
  return 4;
}

function parseArgs(argv) {
  const args = { tier: null, batches: 8, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tier') args.tier = argv[++i];
    else if (argv[i] === '--batches') args.batches = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  if (!RANKS.includes(args.tier) || args.tier === 'なし') throw new Error(`--tier は ${RANKS.slice(1).join('/')} のどれか`);
  if (!Number.isInteger(args.batches) || args.batches < 1) throw new Error('--batches は1以上の整数');
  if (!args.out) throw new Error('--out が要る');
  return args;
}

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

function main() {
  const args = parseArgs(process.argv.slice(2));
  const characters = readJson('data/characters.json');
  const supply = readJson('data/supply.json');
  const quotes = readJson('data/quotes.json');
  const want = RANKS.indexOf(args.tier);

  const bySeries = new Map();
  for (const c of characters) {
    const e = supply[c.id];
    let rank = 0;
    if (e) {
      rank = dlsiteRank(e.pageCount);
      if (e.hitomi) rank = Math.max(rank, hitomiRank(e.hitomi.galleryCount));
    }
    if (rank !== want) continue;
    const entry = {
      id: c.id,
      name: c.name,
      aliases: c.aliases ?? [],
      series: c.series,
      existing: (quotes.characters[c.id] ?? []).map((q) => q.text),
    };
    if (!bySeries.has(c.series)) bySeries.set(c.series, []);
    bySeries.get(c.series).push(entry);
  }

  const total = [...bySeries.values()].reduce((n, list) => n + list.length, 0);
  const target = Math.ceil(total / args.batches);
  // 目安を超える作品だけ、目安の大きさに切ってから詰める。
  const chunks = [];
  for (const list of bySeries.values()) {
    for (let i = 0; i < list.length; i += target) chunks.push(list.slice(i, i + target));
  }
  chunks.sort((a, b) => b.length - a.length || (a[0].series < b[0].series ? -1 : 1));
  const batches = Array.from({ length: args.batches }, () => []);
  for (const chunk of chunks) {
    const lightest = batches.reduce((best, b) => (b.length < best.length ? b : best), batches[0]);
    lightest.push(...chunk);
  }

  const out = resolve(ROOT, args.out);
  mkdirSync(out, { recursive: true });
  batches.forEach((b, i) => {
    writeFileSync(join(out, `batch-${String(i + 1).padStart(2, '0')}.input.json`), `${JSON.stringify(b, null, 1)}\n`);
  });
  console.log(`${args.tier}: ${total}体・${bySeries.size}作品 → ${args.batches}組（${batches.map((b) => b.length).join('・')}）→ ${out}`);
}

main();
