#!/usr/bin/env node
/**
 * ベイズ推薦エンジン試作（PLAN「P5: Wikidata + ニコニコ大百科/ローカルLLM抽出」）向けの
 * ニコニコ大百科（dic.nicovideo.jp）クライアント。アプリからは一切importしない
 * 独立プロセス側の共有モジュール（scripts/bayes/map-niconico.mjs から使う）。
 *
 * 取得するのは記事本文のテキストのみ（画像・コメント・編集履歴は取得しない）。
 * robots.txtにAIクローラー個別ブロックは無く（2026-07-25確認。Pixivの
 * ClaudeBot/anthropic-ai名指しDisallowとは対照的）、`Crawl-delay: 5` が
 * 明示されているのでそれを自主規制の間隔として使う。記事ページ（`/a/`配下）は
 * robots.txtのDisallow対象外（`/p/` `/d/` `/s/` `/api/` 等の機能パスのみ制限）。
 */
import { pathToFileURL } from 'node:url';

/** robots.txtが明示する Crawl-delay をそのまま自主規制の間隔にする。 */
export const REQUEST_DELAY_MS = 5_000;

export const USER_AGENT =
  'chara-picker-bayes/0.1 (+https://github.com/terasaki-8910; article text extraction only, no image/comment fetch)';

const SITE_ROOT = 'https://dic.nicovideo.jp';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @typedef {(url: string, init?: { headers?: Record<string, string> }) =>
 *   Promise<{ ok: boolean, status: number, text: () => Promise<string> }>} NiconicoFetchLike
 */

/**
 * danbooru-client.mjs/wikidata-client.mjs と同じ形の薄いスロットラー。
 * @param {{ fetchImpl?: NiconicoFetchLike, delayMs?: number }} [opts]
 */
export function createNiconicoFetcher({ fetchImpl = fetch, delayMs = REQUEST_DELAY_MS } = {}) {
  let lastCallAt = null;

  return async function niconicoFetch(path) {
    if (lastCallAt !== null) {
      const wait = delayMs - (Date.now() - lastCallAt);
      if (wait > 0) await sleep(wait);
    }
    lastCallAt = Date.now();
    return fetchImpl(`${SITE_ROOT}${path}`, { headers: { 'User-Agent': USER_AGENT } });
  };
}

/**
 * ニコニコ大百科の「表記ゆれ/別名」リダイレクトスタブページ（HTTP 200を返すが
 * 本文が無く、meta refreshとJS location.replaceで正式タイトルへ転送するだけの
 * 847バイト程度の空ページ）から転送先パスを取り出す。fetchはHTTPレベルの3xxしか
 * 自動追跡しないため、このJS/meta-refresh方式のリダイレクトは自前で追う必要がある
 * （2026-07-25、「スカサハ」が実際には「スカアハ」という表記ゆれのリダイレクト
 * スタブになっており、これを地の文として本文検証にかけていたため
 * fate-scathachが誤って除外されていた実例で発覚）。
 * @param {string} html
 * @returns {string | null} `/a/<title>` 形式のパス、リダイレクトでなければnull
 */
export function extractRedirectPath(html) {
  const match = html.match(/location\.replace\('([^']+)'\)/);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    return `${url.pathname}${url.search}`;
  } catch (_err) {
    return null;
  }
}

/**
 * 記事タイトルから `/a/<title>` のHTMLを取得する。存在しない記事は404なので
 * null を返す（DLsite/hitomiの0件と同じくエラーにしない）。表記ゆれリダイレクト
 * スタブに当たった場合は自動で1回だけ転送先を追う。
 * @param {ReturnType<typeof createNiconicoFetcher>} niconicoFetch
 * @param {string} title 記事タイトル（例: "博麗霊夢"）
 * @returns {Promise<string | null>} 生HTML（リダイレクト追跡後）、404ならnull
 */
export async function fetchArticleHtml(niconicoFetch, title) {
  const path = `/a/${encodeURIComponent(title)}`;
  const res = await niconicoFetch(path);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`ニコニコ大百科の取得に失敗しました (status=${res.status}): ${path}`);
  }
  const html = await res.text();

  const redirectPath = extractRedirectPath(html);
  if (redirectPath === null || redirectPath === path) return html;

  const redirectRes = await niconicoFetch(redirectPath);
  if (redirectRes.status === 404) return null;
  if (!redirectRes.ok) {
    throw new Error(`ニコニコ大百科のリダイレクト先取得に失敗しました (status=${redirectRes.status}): ${redirectPath}`);
  }
  return redirectRes.text();
}

/**
 * 生HTMLから本文相当のプレーンテキストへ正規化する。LLMへ渡す文字列と
 * 引用照合の基準文字列を完全に同一にするための唯一の変換経路
 * （PLAN「照合基準ズレ」対策——正規化を2箇所で別々に実装すると必ずズレる）。
 * 外部HTMLパーサ依存を増やさないため正規表現ベース。厳密なDOM解析ではないが、
 * 「LLMが本文らしき範囲から根拠を引用でき、その引用がこの文字列に実在する」
 * という照合ゲートの目的には十分（多少のナビゲーション文字列混入は許容——
 * 抽出結果はconfidence:'high'かつ引用実在チェック通過のみ採用するため実害は薄い）。
 * @param {string} html
 * @returns {string}
 */
/**
 * ニコニコ大百科のコメント欄で必ず使われる匿名投稿者の固定表示名。記事本文の
 * 地の文には出現しないプラットフォーム固有の文字列なので、この初出位置より
 * 後ろをコメント欄とみなして切り捨てる。
 *
 * 2026-07-25、touhou-reimuでLLM抽出の引用照合ゲート通過率が18回中0回だった実例を
 * 調査した結果判明: 本文中に実在する地の文（例:「性格は単純だが裏表が無い」）が
 * あるにもかかわらず、LLMはコメント欄の砕けた文体（ワロタ等の実況スラング）に
 * 引きずられたと見られる創作的な「引用」を返していた。15記事を無作為に確認した
 * ところ、このマーカー以降のコメント欄が記事全体の32%〜87%（平均で過半数）を
 * 占めており、地の文に対してノイズの比率が非常に高い状態でLLMに渡していたことが
 * 分かった。コメントは編集不可能な雑談・時系列断片であり性格・種族等の確立された
 * 設定の根拠にはならないため、除去して困る理由が無い。
 */
const COMMENT_SECTION_MARKER = 'ななしのよっしん';

export function htmlToText(html) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // ブロック要素は改行に変えて段落構造を最低限残す（引用の可読性のため）。
    .replace(/<\/(p|div|li|h[1-6]|tr|td|th|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // 残る要素(主に<a>: ニコニコ大百科はほぼ全ての固有名詞をリンク化する)は
    // 空文字に置き換える——スペースに置き換えると「「あーうー」」のような
    // 「」で囲まれたリンク付き語の内側にスペースが挿入され、LLMが出力する
    // 装飾無しの引用（「あーうー」）と本文側の照合基準文字列がズレて
    // 偽陰性になる（2026-07-25、touhou-suwakoの実地抽出で発覚——本文の
    // 印象的な台詞「あーうー」自体はLLMが正しく引用していたのに、本文側が
    // タグ除去の副作用で「 あーうー 」になっていたため照合に失敗していた）。
    .replace(/<[^>]+>/g, '');

  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));

  const normalized = normalizeWhitespace(text);
  const commentIdx = normalized.indexOf(COMMENT_SECTION_MARKER);
  return commentIdx === -1 ? normalized : normalized.slice(0, commentIdx).trim();
}

/**
 * 空白ラン（半角スペース・改行・タブの連続）を単一の半角スペースへ畳む。
 * LLM入力・引用照合の両方でこの関数を通した文字列だけを使うこと
 * （どちらかだけ正規化すると引用が一致しなくなる）。
 * @param {string} text
 * @returns {string}
 */
export function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  console.error('このファイルはライブラリです。map-niconico.mjs から呼んでください。');
  process.exitCode = 1;
}
