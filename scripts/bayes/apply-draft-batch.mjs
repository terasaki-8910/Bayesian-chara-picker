#!/usr/bin/env node
/**
 * 500体拡張 Stage 1: 下書きJSON（1体ずつ axes 込みで手書きしたキャラ配列。
 * `danbooruTag` フィールドだけ Character 型に無い拡張——このスクリプトが
 * tag-overrides.json の overrides に転記してから取り除く）を
 * data/characters.json に追記し、対応する Danbooru タグを overrides として
 * 確定させる。全員 reviewed:false・provisional:false の下書きとして追加する
 * （人間レビューは対象外、SPEC 6.1「供給先行・属性は後追い」方針）。
 *
 * overrides に理由付きで書く根拠: 下書きの danbooruTag は
 * build-candidates.mjs/resolve-candidate-series.mjs が実行時に
 * genderRatio・1girl優位性・シリーズ共起率50%以上を検証済みの候補タグそのものであり、
 * map-characters.mjs 側のワイルドカード再導出に頼るより確実（500体拡張Stage 0/1）。
 *
 * 使い方: node scripts/bayes/apply-draft-batch.mjs <draft1.json> [draft2.json ...]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OVERRIDE_REASON =
  '500体拡張Stage 0/1で確定済みのDanbooru候補タグをそのまま採用。' +
  '候補生成時にgenderRatio/1girl優位性、シリーズ候補はwikiリンクとの共起率50%以上を検証済み。';

async function main(draftPaths) {
  if (draftPaths.length === 0) {
    console.error('使い方: node scripts/bayes/apply-draft-batch.mjs <draft1.json> [draft2.json ...]');
    process.exitCode = 1;
    return;
  }

  const dataDir = new URL('../../data/', import.meta.url);
  const charactersPath = fileURLToPath(new URL('characters.json', dataDir));
  const overridesPath = fileURLToPath(new URL('bayes/tag-overrides.json', dataDir));

  const characters = JSON.parse(readFileSync(charactersPath, 'utf8'));
  const overridesFile = JSON.parse(readFileSync(overridesPath, 'utf8'));
  const existingIds = new Set(characters.map((c) => c.id));

  let added = 0;
  for (const draftPath of draftPaths) {
    const drafts = JSON.parse(readFileSync(draftPath, 'utf8'));
    for (const draft of drafts) {
      if (existingIds.has(draft.id)) {
        console.error(`スキップ（id重複）: ${draft.id}`);
        continue;
      }
      const { danbooruTag, ...rest } = draft;
      const character = {
        ...rest,
        reviewed: rest.reviewed ?? false,
        provisional: rest.provisional ?? false,
        imagePath: rest.imagePath ?? null,
        imageApproved: rest.imageApproved ?? false,
      };
      characters.push(character);
      existingIds.add(draft.id);
      if (danbooruTag) {
        overridesFile.overrides[draft.id] = { tag: danbooruTag, reason: OVERRIDE_REASON };
      }
      added += 1;
    }
  }

  writeFileSync(charactersPath, `${JSON.stringify(characters, null, 2)}\n`);
  writeFileSync(overridesPath, `${JSON.stringify(overridesFile, null, 2)}\n`);
  console.log(`追加: ${added}件。data/characters.json 合計 ${characters.length}件。`);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main(process.argv.slice(2));
}
