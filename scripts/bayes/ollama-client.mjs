#!/usr/bin/env node
/**
 * ローカルOllama (/api/chat) の薄いラッパ。qwen3:8bでのevidence-first
 * 抽出（scripts/bayes/llm-extract.mjs）専用に使う。ネットワーク越しの外部APIでは
 * なくlocalhost常駐プロセスへの呼び出しのため、danbooru/wikidata/niconicoの
 * ような間隔自主規制・UA送出は不要（相手はレート制限のある公開サービスではない）。
 *
 * 実地確認（2026-07-25、Ollama 0.32.3・qwen3:8b、localhost:11434で実行中）:
 *   - `/api/chat` + トップレベル`think:false` + `format`にJSONスキーマオブジェクトを
 *     渡す組み合わせで、qwen3の思考トレースを含まないスキーマ準拠JSONが安定して返る
 *     ことをキャラ記事1件（紅美鈴、東方Project）で実地確認済み。
 *   - **この実地検証でquote先出しスキーマの必要性そのものを実証した**: quote/valueを
 *     素朴に並列フィールドにした最初の試行ではhairColorが「黒」（誤り、正しくは
 *     「赤」）という誤判定を返し、しかも"evidence"欄はvalueの単純な繰り返しで
 *     実際の引用になっていなかった。quoteをvalueより前に置く必須フィールドへ
 *     スキーマを変えたところvalueは「赤」に修正されたが、それでもquote自体が
 *     本文に実在しない文字列（「紅美鈴（みずき みすず）」）になっているケースが残った
 *     ——つまり「quoteを先に書かせる」だけでは幻覚を防げず、
 *     **quoteが原文に実在するかを機械的に照合するゲートが必須**という結論の
 *     実地根拠になっている（PLANのevidence-first設計はこの検証結果を踏まえたもの）。
 *   - 初回呼び出しはモデルロードで数秒余分にかかる（load_duration）。以降は
 *     生成時間のみ。
 */
import { pathToFileURL } from 'node:url';
const API_ROOT = 'http://localhost:11434';

/**
 * @typedef {(url: string, init?: { method?: string, headers?: Record<string,string>, body?: string }) =>
 *   Promise<{ ok: boolean, status: number, json: () => Promise<unknown>, text: () => Promise<string> }>} OllamaFetchLike
 */

/**
 * `<think>...</think>` ブロックが出力に混入していた場合に取り除く（防御的実装。
 * `think:false`指定時の実地確認では出現しなかったが、モデル/Ollama側の挙動変化に
 * 備える）。
 * @param {string} raw
 * @returns {string}
 */
export function stripThinkTags(raw) {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * @param {{ fetchImpl?: OllamaFetchLike, apiRoot?: string }} [opts]
 */
export function createOllamaClient({ fetchImpl = fetch, apiRoot = API_ROOT } = {}) {
  /**
   * @param {{ model: string, systemPrompt: string, userPrompt: string, format: object, seed: number, numCtx?: number }} params
   * @returns {Promise<unknown>} format スキーマに準拠したパース済みJSON
   */
  return async function chat({ model, systemPrompt, userPrompt, format, seed, numCtx = 32768 }) {
    const res = await fetchImpl(`${apiRoot}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        think: false,
        stream: false,
        format,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        // 既定のnum_ctx(多くのOllamaモデルで4096)だと長文記事（東方Project系で
        // 6000〜15000トークン超）がプロンプト時点で溢れてstatus=400になることが
        // 実地確認で判明した（2026-07-25、touhou-yukari他21件で再現）。
        options: { temperature: 0, seed, num_ctx: numCtx },
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama /api/chat 呼び出しに失敗しました (status=${res.status}): ${await res.text()}`);
    }
    const result = /** @type {{ message: { content: string } }} */ (await res.json());
    const cleaned = stripThinkTags(result.message.content);
    try {
      return JSON.parse(cleaned);
    } catch (_err) {
      throw new Error(`Ollamaの応答がJSONとして解釈できませんでした: ${cleaned.slice(0, 200)}`);
    }
  };
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  console.error('このファイルはライブラリです。llm-extract.mjs から呼んでください。');
  process.exitCode = 1;
}
