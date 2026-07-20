#!/usr/bin/env node
/**
 * hitomi.la の series タグから、そのシリーズのキャラクターを供給量順に列挙する。
 *
 * 目的は「どのキャラを収録候補にするか」を私（Claude）の記憶ではなく実データから
 * 決めること。キャラ名を思い出そうとすると、存在しないキャラや誤った表記を
 * 生成する危険がある（SPEC 4.3）。実際に作品が存在するタグだけが出てくるこの方法なら
 * その危険がない。
 *
 * 使うのは character / series タグのみ。hitomi の属性タグ（眼鏡・褐色など）は
 * 使わない — 属性の正しさは hitomi のタグ付けに依存しており信用できないため、
 * 本プロジェクトでの hitomi の役割は「供給の確認」に限定する（SPEC 2.2）。
 *
 * 画像・作品本文は取得しない。読むのは作品メタデータ（characters / parodys）のみ。
 *
 *   node scripts/census-hitomi.mjs "blue archive" [サンプル数]
 */
import { createHitomiFetcher, buildNozomiUrl, parseNozomiIds } from './collect-hitomi.mjs';

const GALLERY_META_BASE = 'https://ltn.gold-usergeneratedcontent.net/galleries';

/** メタデータ取得の間隔。nozomi より軽い静的 JS なので短くするが、無遠慮にはしない。 */
const META_DELAY_MS = 200;

/**
 * 自己投影用の主人公など、キャラクターとして収録しないタグ。
 * 供給量が突出するので放置すると常に 1 位を占める。
 */
const EXCLUDED_TAGS = new Set(['sensei', 'reader', 'onii-chan', 'original']);

async function fetchIds(fetcher, area, tag) {
  const res = await fetcher(buildNozomiUrl({ area, tag }));
  if (res.status === 404) return new Set();
  if (!res.ok) throw new Error(`census に失敗しました (status=${res.status}): ${area}/${tag}`);
  return parseNozomiIds(await res.arrayBuffer());
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ギャラリー ID の集合から一定間隔でサンプルを抜く。先頭に偏らせない
 * （nozomi は概ね新着順なので、先頭だけ見ると最近のキャラに偏る）。
 */
export function pickEvenly(ids, sampleSize) {
  const list = [...ids];
  if (list.length <= sampleSize) return list;
  const step = list.length / sampleSize;
  const picked = [];
  for (let i = 0; picked.length < sampleSize && Math.floor(i * step) < list.length; i += 1) {
    picked.push(list[Math.floor(i * step)]);
  }
  return picked;
}

async function main() {
  const seriesTag = process.argv[2];
  const sampleSize = Number(process.argv[3] ?? 700);
  if (!seriesTag) {
    console.error('使い方: node scripts/census-hitomi.mjs "<series タグ>" [サンプル数]');
    process.exitCode = 1;
    return;
  }

  const fetcher = createHitomiFetcher({});
  const seriesIds = await fetchIds(fetcher, 'series', seriesTag);
  if (seriesIds.size === 0) {
    console.error(`series:"${seriesTag}" のタグが見つかりません。タグ名を確認してください。`);
    process.exitCode = 1;
    return;
  }
  console.error(`series:"${seriesTag}" 総作品数 = ${seriesIds.size}`);

  const picked = pickEvenly(seriesIds, sampleSize);
  console.error(`${picked.length} 件をサンプリングします...`);

  const freq = new Map();
  let parsed = 0;
  for (const id of picked) {
    try {
      const res = await fetch(`${GALLERY_META_BASE}/${id}.js`);
      const info = JSON.parse((await res.text()).replace('var galleryinfo = ', ''));
      // 合同誌は複数シリーズを含む。対象シリーズを含まないものは数えない。
      if (!(info.parodys ?? []).some((p) => p.parody === seriesTag)) continue;
      for (const entry of info.characters ?? []) {
        const tag = entry.character;
        if (EXCLUDED_TAGS.has(tag)) continue;
        freq.set(tag, (freq.get(tag) ?? 0) + 1);
      }
      parsed += 1;
    } catch (_err) {
      // 個別作品のメタデータ欠損は無視する。母数が大きいので統計に影響しない。
    }
    await sleep(META_DELAY_MS);
  }
  console.error(`解析できた作品 = ${parsed}`);

  // サンプル頻度は候補の抽出にだけ使い、最終的な件数は character∩series の実数で出す。
  // 合同誌経由で他シリーズのキャラが混ざるので、その除去も兼ねる。
  const candidates = [...freq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  console.error(`候補 ${candidates.length} 件の実数を確定します...`);

  const rows = [];
  for (const [tag, sampleHits] of candidates) {
    const charIds = await fetchIds(fetcher, 'character', tag);
    let inSeries = 0;
    for (const id of charIds) if (seriesIds.has(id)) inSeries += 1;
    // 対象シリーズ内の比率が低いタグは、合同誌経由で紛れ込んだ他シリーズのキャラ。
    const ratio = charIds.size === 0 ? 0 : inSeries / charIds.size;
    rows.push({ tag, sampleHits, totalGalleries: charIds.size, inSeries, ratio: Number(ratio.toFixed(3)) });
  }

  rows.sort((a, b) => b.inSeries - a.inSeries);
  console.log(JSON.stringify({ seriesTag, seriesTotal: seriesIds.size, sampled: parsed, characters: rows }, null, 2));
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  await main();
}
