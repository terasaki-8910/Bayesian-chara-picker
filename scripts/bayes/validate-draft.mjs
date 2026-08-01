#!/usr/bin/env node
/**
 * 500体拡張 Stage 1: 下書きJSON（apply-draft-batch.mjsへ渡す前段）をスキーマ・
 * A4(必須8軸)・A11(任意軸4つ以上)相当のルールで検証する。src/data/schema.tsの
 * enumと二重化している（ACCEPTANCE A5と同じ「二重化が検出力そのもの」の考え方）。
 *
 * 使い方: node scripts/bayes/validate-draft.mjs <draft1.json> [draft2.json ...]
 */
import { readFileSync } from 'node:fs';

const ENUMS = {
  genderExpression: ['女性', 'おとこの娘', 'ふたなり', '男性'],
  ageFeel: ['幼い', '同年代', '年上', '熟れた'],
  build: ['華奢', '標準', 'むっちり'],
  bust: ['小さい', '標準', '大きい', 'とても大きい'],
  personality: ['クール', '元気', 'おっとり', '生意気', '内気', '姉御', 'むっつり'],
  roles: ['幼馴染', '後輩', '先輩', '姉', '妹', '母性', '教師', '主従', 'ライバル', '恋人・伴侶', '友人'],
  distance: ['積極的', 'やや積極的', '中立', 'やや受け身', '受け身'],
  looks: ['眼鏡', 'ケモミミ', '角', '尻尾', '長髪', 'ツインテール', '眼帯'],
  hairColor: ['黒', '白', '金', '茶', '赤', '青', '緑', '桃', '紫', '銀', '橙'],
  skinTone: ['色白', '標準', '褐色'],
  outfit: ['制服', 'メイド', '巫女', 'ナース', '魔法少女', '軍服', 'OL', '和服・着物'],
  species: ['人間', 'エルフ', '獣人', '魔族', '機械', '不死'],
  mood: ['甘め', '支配的', '従属的', '純愛寄り', '背徳寄り'],
  combat: ['戦う', '戦わない'],
  affiliationKind: ['学生', '社会人', '軍・組織', '冒険者', '非人間・その他'],
  occupation: [
    '忍者', '海賊', '兵士・軍人', '警察・公安', 'スパイ・暗殺者', 'アイドル・芸能',
    'アスリート', '巫女・神職', '神様・精霊', 'メイド・従者', '王族・貴族',
    '医療従事者', '研究者・発明家', '魔法使い・魔術師', '会社員・OL', '教師・講師', '格闘家・武道家',
  ],
  stature: ['小柄', '標準', '長身'],
};
const REQUIRED_8 = ['genderExpression', 'ageFeel', 'build', 'bust', 'personality', 'hairColor', 'combat', 'affiliationKind'];
const OPTIONAL_10 = ['roles', 'distance', 'looks', 'skinTone', 'outfit', 'species', 'mood', 'affiliationName', 'stature', 'occupation'];
const MIN_OPTIONAL_FILLED = 4;

function isFilled(v) {
  return Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== '';
}

function validateOne(ch) {
  const errors = [];
  const a = ch.axes ?? {};
  for (const [axis, val] of Object.entries(a)) {
    if (!(axis in ENUMS)) continue;
    for (const v of Array.isArray(val) ? val : [val]) {
      if (v !== null && !ENUMS[axis].includes(v)) errors.push(`invalid ${axis}=${JSON.stringify(v)}`);
    }
  }
  for (const axis of REQUIRED_8) {
    if (!isFilled(a[axis])) errors.push(`missing required axis: ${axis}`);
  }
  const filled = OPTIONAL_10.filter((axis) => isFilled(a[axis])).length;
  if (filled < MIN_OPTIONAL_FILLED) errors.push(`A11: only ${filled} optional axes filled (need >=${MIN_OPTIONAL_FILLED})`);
  if (!ch.id) errors.push('missing id');
  if (!ch.name) errors.push('missing name');
  if (!ch.series) errors.push('missing series');
  return errors;
}

function main(paths) {
  if (paths.length === 0) {
    console.error('使い方: node scripts/bayes/validate-draft.mjs <draft1.json> [draft2.json ...]');
    process.exitCode = 1;
    return;
  }
  let totalErrors = 0;
  let totalChars = 0;
  const seenIds = new Set();
  for (const path of paths) {
    const drafts = JSON.parse(readFileSync(path, 'utf8'));
    for (const ch of drafts) {
      totalChars++;
      const errors = validateOne(ch);
      if (seenIds.has(ch.id)) errors.push('duplicate id within this validation run');
      seenIds.add(ch.id);
      if (errors.length > 0) {
        console.log(`NG: ${ch.id}`);
        for (const e of errors) console.log(`  - ${e}`);
        totalErrors += errors.length;
      }
    }
  }
  console.log(`\n検証対象 ${totalChars}件、エラー ${totalErrors}件`);
  if (totalErrors > 0) process.exitCode = 1;
}

main(process.argv.slice(2));
