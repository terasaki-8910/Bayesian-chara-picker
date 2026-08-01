#!/usr/bin/env node
/**
 * 16軸手動レビュー支援ツール（PLAN対象外の運用補助スクリプト。通信なし・決定論・
 * 読み取り専用）。`data/characters.json` の下書き axes と、既存の機械的データ源
 * （Wikidata構造化事実・ローカルLLM抽出・Danbooruタグ共起）を軸ごとに突き合わせ、
 * 「下書き値と機械証拠が一致するか」を人間が一覧で素早く判断できるレポートを
 * `state/bayes-review/` へ出力する。
 *
 * **このツールは`characters.json`を一切書き込まない。** `reviewed`フラグを立てる
 * 行為はACCEPTANCE.md §Gが人間専用のゲートと定めており、機械が確定させてよい
 * 領域ではない（SPEC.md §4.3「属性値は提案であって事実ではない」）。証拠が
 * 無い軸を0.5や「たぶん」のような中間値に潰さず、素直に`no-evidence`として
 * 出す設計は`scripts/bayes/estimators.mjs`の`LLM_NO_EVIDENCE`まわりの思想を
 * 踏襲している。
 *
 * 軸ごとの証拠ソース（`data/bayes/questions.json`の`reason.axis`/`sources`を
 * そのまま16軸/証拠源の対応表として再利用する。二重定義しない）:
 *   - danbooru-group / danbooru-binary: state/bayes-pipeline/danbooru/<id>.json
 *     の生投稿タグから比率を計算（build-likelihoods.mjsの集計関数を再利用）
 *   - wikidata: data/bayes/wikidata-facts.json
 *   - llm: data/bayes/llm-extract.json（verified===true && confidence==='high'
 *     のみ証拠採用。理由はestimateLlmLikelihoodと同じ）+
 *     state/bayes-pipeline/llm/<id>.json の verification[] から原文引用を添付
 * `ageFeel`/`build`/`affiliationName`はquestions.jsonに証拠源の定義が無いため
 * 常に`no-evidence`（本番の尤度パイプライン自体がこの3軸をaxisフォールバック
 * のみに頼っているのと同じ限界。新規タグ対応表をここで独自に作ると二重管理に
 * なるため、questions.json側を拡張したい場合はそちらを直接編集すること）。
 *
 * 出力は`state/bayes-review/`（gitignore対象）のみ。LLM証拠のquoteはファンサイト
 * 記事からの引用文なので、他のプロース非混入データ（llm-extract.json等）と同じく
 * コミットツリーに置かない。
 *
 * 使い方:
 *   node scripts/bayes/review-hints.mjs            # 未レビュー(reviewed!==true)全員
 *   node scripts/bayes/review-hints.mjs --char <id> # 単体のみ
 *   node scripts/bayes/review-hints.mjs --all       # reviewed済みも含め全員
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { countBinary, countGroupCoverage, loadDanbooruCache } from './build-likelihoods.mjs';

/** 単一値ではなく配列で持つ軸（schema.tsのAxes型と一致。personality/moodは2026-08-01に複数値化）。 */
const MULTI_AXES = new Set(['roles', 'looks', 'outfit', 'occupation', 'personality', 'mood']);
/** questions.jsonに証拠源の定義が無い軸（常にno-evidence）。
 * ageFeel/build は2026-08-01に質問（axis+llmソース）が追加されたのでここから外した
 * ——このスクリプトは questions.json を証拠源の対応表として再利用する設計なので、
 * 質問が増えれば自動的に評価対象になる。 */
const NO_EVIDENCE_AXES = ['affiliationName'];
/** 「支持されている」とみなす最低スコア（danbooru比率・生率にのみ適用。llm/wikidataの一致は常に1.0）。 */
const SUPPORT_THRESHOLD = 0.4;
/**
 * multi軸で「ドラフトにあるがほぼ根拠が無い」とみなす上限（除去候補フラグ用）。
 * 低めに設定している——「巫女」のように自明すぎる属性ほどファンアート側で
 * 逆にタグ付け率が低くなる傾向が実地確認で判明した（2026-07-26、touhou-reimu で
 * outfit=巫女がDanbooru投稿の2.4%にしかタグ付けされていなかった。miko自体は
 * 事実として正しく、単に「わざわざタグ付けするまでもない」の逆説的な結果）。
 * remove-candidateはこのツールの中で最も信頼性の低いシグナルなので、閾値を
 * 厳しくして誤検出を減らす（それでも参考程度に留め、人間の判断を優先すること）。
 */
const ABSENCE_THRESHOLD = 0.02;

/**
 * questions.json の全質問を reason.axis でグループ化し、軸ごとの
 * 候補値→質問(sources付き) のマップを作る（16軸/証拠源の対応表を導出）。
 * @param {{ questions: { reason: { axis: string, value: string }, sources: object[] }[] }} questionsFile
 */
export function buildAxisEvidenceMap(questionsFile) {
  /** @type {Record<string, { value: string, sources: object[] }[]>} */
  const map = {};
  for (const q of questionsFile.questions) {
    const { axis, value } = q.reason;
    if (!map[axis]) map[axis] = [];
    if (map[axis].some((c) => c.value === value)) continue; // 同じ軸/値の質問が複数ソースを持つ場合は既存エントリのsourcesを使う
    map[axis].push({ value, sources: q.sources });
  }
  return map;
}

/**
 * @param {string} axisKey
 * @param {string} candidateValue
 * @param {object[]} sources
 * @param {{
 *   posts: { id: number, tags: string[] }[],
 *   groupCoverage: Record<string, { nG: number, kByTag: Record<string, number> }>,
 *   groupBaseRate: Record<string, Record<string, number>>,
 *   wikidataFacts: Record<string, unknown> | undefined,
 *   llmEntry: { axes: Record<string, { value?: string, values?: string[], verified: boolean, confidence: string }> } | undefined,
 *   llmStateVerification: { axis: string, role?: string, quote: string, matched: boolean | null }[],
 * }} ctx
 * @returns {{ score: number, detail: string, quote?: string } | null}
 */
function evidenceForCandidate(axisKey, candidateValue, sources, ctx) {
  for (const source of sources) {
    // danbooru-group/danbooru-binary の source オブジェクト自体には value フィールドが
    // 無い（buildAxisEvidenceMap が既に axis+value ごとの質問1件へ絞り込んだ sources を
    // 渡してくるため、ここで再照合する必要も術も無い）。
    if (source.type === 'danbooru-group') {
      const cov = ctx.groupCoverage[source.group];
      if (!cov || cov.nG === 0) continue;
      const kQ = cov.kByTag[source.tag] ?? 0;
      const ratio = kQ / cov.nG;
      return { score: ratio, detail: `Danbooru: ${source.group}群タグ${kQ}/${cov.nG}件 (${(ratio * 100).toFixed(0)}%) がタグ「${source.tag}」` };
    }
    if (source.type === 'danbooru-binary') {
      if (ctx.posts.length === 0) continue;
      const k = countBinary(ctx.posts, source.tag);
      const rate = k / ctx.posts.length;
      return { score: rate, detail: `Danbooru: 投稿${k}/${ctx.posts.length}件 (${(rate * 100).toFixed(0)}%) がタグ「${source.tag}」` };
    }
    if (source.type === 'wikidata' && source.value === candidateValue) {
      const raw = ctx.wikidataFacts?.[source.axis];
      const matched = source.multi ? Array.isArray(raw) && raw.includes(source.value) : raw === source.value;
      if (matched) return { score: 1, detail: `Wikidata: ${source.axis}=${source.value}` };
    }
    if (source.type === 'llm' && source.value === candidateValue) {
      const axisResult = ctx.llmEntry?.axes?.[source.axis];
      if (!axisResult || axisResult.confidence !== 'high') continue;
      const matched = source.multi
        ? axisResult.verified === true && Array.isArray(axisResult.values) && axisResult.values.includes(source.value)
        : axisResult.verified === true && axisResult.value === source.value;
      if (!matched) continue;
      const verEntry = ctx.llmStateVerification.find(
        (v) => v.axis === source.axis && v.matched === true && (source.multi ? v.role === source.value : true),
      );
      return { score: 1, detail: `LLM抽出(confidence:high・引用照合済み): ${source.axis}=${source.value}`, quote: verEntry?.quote };
    }
  }
  return null;
}

/**
 * 1キャラ・1軸ぶんのレビューヒントを組み立てる。
 * @returns {{ axis: string, draft: unknown, agreement: 'agree'|'conflict'|'no-evidence', evidence: object[], best?: string }}
 */
export function buildAxisHint(axisKey, draftValue, candidates, ctx) {
  if (NO_EVIDENCE_AXES.includes(axisKey) || candidates.length === 0) {
    return { axis: axisKey, draft: draftValue, agreement: 'no-evidence', evidence: [] };
  }

  if (MULTI_AXES.has(axisKey)) {
    const draftSet = new Set(Array.isArray(draftValue) ? draftValue : []);
    const evidence = [];
    let anyEvidence = false;
    let hasConflict = false;
    for (const { value, sources } of candidates) {
      const found = evidenceForCandidate(axisKey, value, sources, ctx);
      if (found === null) continue;
      anyEvidence = true;
      const supported = found.score >= SUPPORT_THRESHOLD || found.score === 1;
      const inDraft = draftSet.has(value);
      if (supported && !inDraft) {
        hasConflict = true;
        evidence.push({ value, action: 'add-candidate', ...found });
      } else if (!supported && inDraft && found.score <= ABSENCE_THRESHOLD) {
        hasConflict = true;
        evidence.push({ value, action: 'remove-candidate', ...found });
      } else if (supported && inDraft) {
        evidence.push({ value, action: 'confirmed', ...found });
      }
    }
    const agreement = !anyEvidence ? 'no-evidence' : hasConflict ? 'conflict' : 'agree';
    return { axis: axisKey, draft: draftValue, agreement, evidence };
  }

  // 単一値軸
  let best = null;
  const evidence = [];
  for (const { value, sources } of candidates) {
    const found = evidenceForCandidate(axisKey, value, sources, ctx);
    if (found === null) continue;
    evidence.push({ value, ...found });
    if (best === null || found.score > best.score) best = { value, ...found };
  }
  if (best === null || best.score < SUPPORT_THRESHOLD) {
    return { axis: axisKey, draft: draftValue, agreement: 'no-evidence', evidence };
  }
  const agreement = best.value === draftValue ? 'agree' : 'conflict';
  return { axis: axisKey, draft: draftValue, agreement, evidence, best: best.value };
}

function loadJsonOrDefault(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (_err) {
    return fallback;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const charFilter = args.includes('--char') ? args[args.indexOf('--char') + 1] : null;
  const includeReviewed = args.includes('--all');

  const dataDir = new URL('../../data/', import.meta.url);
  const stateDir = new URL('../../state/', import.meta.url);
  const danbooruCacheDir = new URL('bayes-pipeline/danbooru/', stateDir);
  const llmStateDir = new URL('bayes-pipeline/llm/', stateDir);
  const reviewDir = fileURLToPath(new URL('bayes-review/', stateDir));
  mkdirSync(reviewDir, { recursive: true });

  const characters = JSON.parse(readFileSync(fileURLToPath(new URL('characters.json', dataDir)), 'utf8'));
  const questionsFile = JSON.parse(readFileSync(fileURLToPath(new URL('bayes/questions.json', dataDir)), 'utf8'));
  const wikidataFacts = loadJsonOrDefault(fileURLToPath(new URL('bayes/wikidata-facts.json', dataDir)), { entries: {} });
  const llmExtract = loadJsonOrDefault(fileURLToPath(new URL('bayes/llm-extract.json', dataDir)), { entries: {} });

  const axisEvidenceMap = buildAxisEvidenceMap(questionsFile);
  const allAxes = [...new Set([...Object.keys(axisEvidenceMap), ...NO_EVIDENCE_AXES])];

  const targets = characters.filter((c) => {
    if (charFilter) return c.id === charFilter;
    if (includeReviewed) return true;
    return c.reviewed !== true;
  });
  if (targets.length === 0) {
    console.log('対象キャラが0件です（--char のidが正しいか確認してください）。');
    return;
  }

  const records = [];
  for (const character of targets) {
    const posts = loadDanbooruCache(danbooruCacheDir, character.id);
    const groupCoverage = {};
    for (const [group, def] of Object.entries(questionsFile.groups)) {
      groupCoverage[group] = countGroupCoverage(posts, def.coverageTags);
    }
    const llmEntry = llmExtract.entries[character.id];
    const llmState = loadJsonOrDefault(fileURLToPath(new URL(`${character.id}.json`, llmStateDir)), null);
    const ctx = {
      posts,
      groupCoverage,
      groupBaseRate: {}, // 現状未使用（比率をそのまま見せる方針。将来baseRate比較を足す余地として保持）
      wikidataFacts: wikidataFacts.entries[character.id],
      llmEntry,
      llmStateVerification: llmState?.verification ?? [],
    };

    const axisHints = allAxes.map((axisKey) =>
      buildAxisHint(axisKey, character.axes[axisKey], axisEvidenceMap[axisKey] ?? [], ctx),
    );
    const conflictCount = axisHints.filter((h) => h.agreement === 'conflict').length;
    const noEvidenceCount = axisHints.filter((h) => h.agreement === 'no-evidence').length;
    records.push({ id: character.id, name: character.name, series: character.series, conflictCount, noEvidenceCount, axisHints });
  }

  records.sort((a, b) => b.conflictCount - a.conflictCount);

  const jsonPath = `${reviewDir}review-hints.json`;
  writeFileSync(jsonPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), records }, null, 2)}\n`);

  const mdLines = [
    '# 16軸レビューヒント（機械生成・提案であって確定ではない）',
    '',
    'このファイルは `characters.json` を書き換えません。conflict/no-evidence を参考に',
    '`characters.json` の該当キャラを直接編集し、`reviewed:true` を立てるのは人間の判断で行ってください。',
    '',
  ];
  for (const r of records) {
    mdLines.push(`## ${r.name} (${r.id}) — ${r.series}`);
    mdLines.push(`conflict: ${r.conflictCount} / no-evidence: ${r.noEvidenceCount}`);
    mdLines.push('');
    for (const h of r.axisHints) {
      if (h.agreement === 'agree') continue; // 一致は簡潔さのため省略（JSON側には残る）
      const draftStr = Array.isArray(h.draft) ? `[${h.draft.join(', ')}]` : String(h.draft);
      mdLines.push(`- **${h.axis}**（下書き: ${draftStr}）: ${h.agreement}`);
      for (const e of h.evidence) {
        const actionLabel = e.action ? `[${e.action}] ` : '';
        mdLines.push(`  - ${actionLabel}${e.value}: ${e.detail}`);
        if (e.quote) mdLines.push(`    > ${e.quote}`);
      }
    }
    mdLines.push('');
  }
  const mdPath = `${reviewDir}review-hints.md`;
  writeFileSync(mdPath, `${mdLines.join('\n')}\n`);

  console.log(`対象 ${records.length} 件のレビューヒントを書き出しました。`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${mdPath}`);
  console.log('\n=== conflict件数が多い順 上位10件 ===');
  for (const r of records.slice(0, 10)) {
    console.log(`  ${r.id} (${r.name}): conflict=${r.conflictCount}, no-evidence=${r.noEvidenceCount}`);
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
