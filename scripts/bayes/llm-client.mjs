#!/usr/bin/env node
/**
 * ローカルLLM（llama.cpp の llama-server、router モード、OpenAI 互換）の薄いラッパ。
 * evidence-first 抽出（scripts/bayes/llm-extract.mjs）とモデル比較
 * （scripts/bayes/bench-llm-models.mjs）専用。旧 ollama-client.mjs（Ollama /api/chat）
 * を置き換えたもの。
 *
 * サーバーの起動・モデル一覧・研究用途の規則は ~/tools/localllm/README.md、参照実装は
 * ~/tools/localllm/localllm/__init__.py の chat() / run_info()。モデル名は
 * ~/tools/localllm/models.ini のセクション名（Ollama 名の `:` を `-` に替えたもの）。
 * 接続先は環境変数 LOCALLLM_URL（既定 http://127.0.0.1:8080）。localhost 常駐プロセスへの
 * 呼び出しなので、danbooru/wikidata/niconico のような間隔自主規制・UA 送出は不要。
 *
 * 生成設定は全部明示する（省くとサーバー既定になり、モデルやビルドを替えたときに
 * 一緒に変わるため）:
 *   - temperature:0 + 固定 seed。llama.cpp は温度0以下で最大ロジットのトークンだけを残す。
 *   - top_k/top_p/min_p は温度0では候補の切り詰めに過ぎず結果に効かないが、記録のため明示。
 *   - repeat_penalty/presence_penalty/frequency_penalty は温度0でも最大ロジットの選択の
 *     前にロジットを書き換えるので結果に効く。抽出はスキーマどおりの反復構造
 *     （同じキー名を11軸分繰り返す JSON）を出させるため、罰則を掛けない（1.0 / 0 / 0）。
 *   - max_tokens:4096 は暴走生成の安全弁。旧 Ollama 版の num_predict:4096 と同じ値で、
 *     意図的に変えない。経緯: Ollama 既定の num_predict は無制限で、生成が暴走ループすると
 *     stream:false のため応答ヘッダすら返らないまま文脈長を埋めるまで生成が続き、Node
 *     fetch(undici) の既定ヘッダタイムアウト(5分)で「fetch failed」になった（2026-08-01、
 *     fate-scathach/fate-raikou で再現。温度0・固定 seed のため再実行でも決定論的に再発）。
 *     健全な応答は全11軸の抽出 JSON でも1500トークン程度なので4096で十分な余裕がある。
 *     上限で切れた応答は finish_reason:'length' になり、code:'TRUNCATED' のエラーにする
 *     （bench が「途中で切れた数」を数える）。
 *   - cache_prompt:false。true（サーバー既定）では共通の前半を再利用し、llama.cpp の文書は
 *     そのときロジットがビット単位では一致しない場合があるとしている（README 参照）。
 *     抽出は1キャラにつき1回の呼び出し+少しの再試行なので、速度の損は小さい。
 *   - 思考なし: chat_template_kwargs.enable_thinking:false と reasoning_effort:'none'
 *     （参照実装と同じ指定）。
 *   - JSON スキーマ制約: response_format {type:'json_schema', json_schema:{schema}}。
 *     llama-server はこれを文法（GBNF）に変換して生成を縛る。
 *
 * 旧 Ollama 版の実地確認（2026-07-25、qwen3:8b）で、quote を value より前の必須フィールドに
 * しても quote 自体が本文に実在しない文字列になるケースが残った。このため quote の実在を
 * 機械的に照合するゲート（llm-extract.mjs の verifyQuote）が必須、という設計になっている。
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ENGINE = 'llama.cpp';
export const DEFAULT_API_ROOT = 'http://127.0.0.1:8080';
/** 暴走生成の安全弁（上のコメント参照）。変えないこと。 */
export const MAX_TOKENS = 4096;
/** 温度0では top_k/top_p/min_p は結果に効かない（記録のため明示）。罰則は結果に効くので切る。 */
export const SAMPLER = Object.freeze({
  top_k: 40,
  top_p: 1.0,
  min_p: 0.0,
  repeat_penalty: 1.0,
  presence_penalty: 0.0,
  frequency_penalty: 0.0,
});

/** 参照実装と共有する sha256 キャッシュ（キーの形も同じ）。 */
const SHA_CACHE_PATH = join(homedir(), '.cache', 'localllm', 'sha256.json');

/**
 * @typedef {(url: string, init?: { method?: string, headers?: Record<string,string>, body?: string }) =>
 *   Promise<{ ok: boolean, status: number, json: () => Promise<unknown>, text: () => Promise<string> }>} LlmFetchLike
 */

/** 接続先。LOCALLLM_URL があればそれ、無ければ既定値。末尾の / は落とす。 */
export function resolveApiRoot() {
  return (process.env.LOCALLLM_URL || DEFAULT_API_ROOT).replace(/\/+$/, '');
}

/**
 * `<think>...</think>` ブロックが出力に混入していた場合に取り除く（防御的実装。
 * 思考なし指定では通常 reasoning_content 側に分かれるか出ないが、テンプレートや
 * サーバー側の挙動変化に備える）。
 * @param {string} raw
 * @returns {string}
 */
export function stripThinkTags(raw) {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * @param {{ model: string, systemPrompt: string, userPrompt: string, format: object, seed: number }} params
 */
export function buildChatBody({ model, systemPrompt, userPrompt, format, seed }) {
  return {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
    temperature: 0,
    seed,
    max_tokens: MAX_TOKENS,
    ...SAMPLER,
    cache_prompt: false,
    chat_template_kwargs: { enable_thinking: false },
    reasoning_effort: 'none',
    response_format: { type: 'json_schema', json_schema: { name: 'extraction', strict: true, schema: format } },
  };
}

/**
 * @param {{ fetchImpl?: LlmFetchLike, apiRoot?: string }} [opts]
 */
export function createLlmClient({ fetchImpl = fetch, apiRoot = resolveApiRoot() } = {}) {
  /**
   * @param {{ model: string, systemPrompt: string, userPrompt: string, format: object, seed: number }} params
   * @returns {Promise<unknown>} format スキーマに準拠したパース済み JSON
   */
  return async function chat(params) {
    const res = await fetchImpl(`${apiRoot}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildChatBody(params)),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`llama-server /v1/chat/completions 呼び出しに失敗しました (status=${res.status}): ${body.slice(0, 500)}`);
    }
    const result = /** @type {{ choices: { finish_reason?: string, message: { content?: string | null } }[] }} */ (
      await res.json()
    );
    const choice = result.choices?.[0];
    if (!choice) {
      throw new Error(`llama-server の応答に choices がありません: ${JSON.stringify(result).slice(0, 200)}`);
    }
    if (choice.finish_reason === 'length') {
      const err = new Error(`llama-server の出力が max_tokens(${MAX_TOKENS}) で切れました（model=${params.model}）`);
      /** @type {any} */ (err).code = 'TRUNCATED';
      throw err;
    }
    const cleaned = stripThinkTags(choice.message?.content ?? '');
    try {
      return JSON.parse(cleaned);
    } catch (_err) {
      throw new Error(`llama-server の応答が JSON として解釈できませんでした: ${cleaned.slice(0, 200)}`);
    }
  };
}

/**
 * GGUF の sha256。Ollama の blob はファイル名がそのまま sha256。それ以外は計算して
 * ~/.cache/localllm/sha256.json にキャッシュする（参照実装 sha256_of と同じキー）。
 * @param {string} path
 * @param {{ cachePath?: string }} [opts]
 */
export async function sha256Of(path, { cachePath = SHA_CACHE_PATH } = {}) {
  const name = basename(path);
  if (name.startsWith('sha256-') && name.length === 71) return name.slice(7);
  const st = statSync(path);
  const key = `${resolve(path)}|${st.size}|${Math.floor(st.mtimeMs / 1000)}`;
  let cache = {};
  try {
    cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
  } catch (_err) {
    cache = {};
  }
  if (!cache[key]) {
    const hash = createHash('sha256');
    await new Promise((ok, ng) => {
      createReadStream(path, { highWaterMark: 1 << 24 })
        .on('data', (chunk) => hash.update(chunk))
        .on('end', ok)
        .on('error', ng);
    });
    cache[key] = hash.digest('hex');
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache, null, 1));
  }
  return cache[key];
}

/**
 * 実行記録に残す実行環境（参照実装 run_info と同じ内容）。load=true なら
 * /props?model=…&autoload=true でモデルを読み込ませてから調べる。
 * @param {string} model
 * @param {{ fetchImpl?: LlmFetchLike, apiRoot?: string, load?: boolean, sha256Impl?: (path: string) => Promise<string> }} [opts]
 */
export async function runInfo(model, { fetchImpl = fetch, apiRoot = resolveApiRoot(), load = true, sha256Impl = sha256Of } = {}) {
  const getJson = async (path) => {
    const res = await fetchImpl(`${apiRoot}${path}`);
    if (!res.ok) {
      throw new Error(`llama-server ${path} 呼び出しに失敗しました (status=${res.status}): ${(await res.text()).slice(0, 500)}`);
    }
    return /** @type {any} */ (await res.json());
  };
  const q = `?model=${encodeURIComponent(model)}`;
  if (load) await getJson(`/props${q}&autoload=true`);
  const models = (await getJson('/models')).data ?? [];
  const entry = models.find((m) => m.id === model);
  if (!entry) throw new Error(`${model} は models.ini にありません`);
  const props = await getJson(`/props${q}`);
  const modelPath = props.model_path || entry.path || null;
  return {
    engine: ENGINE,
    build_info: props.build_info ?? null,
    model,
    model_path: modelPath,
    model_sha256: modelPath ? await sha256Impl(modelPath) : null,
    server_args: entry.status?.args ?? null,
    total_slots: props.total_slots ?? null,
    default_generation_settings: props.default_generation_settings?.params ?? null,
    client_settings: { temperature: 0, max_tokens: MAX_TOKENS, sampler: { ...SAMPLER }, cache_prompt: false, think: false },
  };
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  console.error('このファイルはライブラリです。llm-extract.mjs / bench-llm-models.mjs から呼んでください。');
  process.exitCode = 1;
}
