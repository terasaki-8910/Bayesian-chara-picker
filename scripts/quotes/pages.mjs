/**
 * 名台詞: 出どころのページを取ってきて本文にする（page-excerpts.mjs と check-pages.mjs から使う）。
 *
 * 取り方の決まり:
 *   - robots.txt に従う。User-agent: * に加えて、Claude と Anthropic のクローラーの組も見る
 *     （AI の取得を断っているサイトは取らない。ピクシブ百科事典・ポケモンWiki など）。
 *   - 同じホストへは2秒（Crawl-delay があればその秒数、HOST_MIN_INTERVAL_MS にあればその長さ）あける。
 *   - 1ページを1回だけ取り、本文を state/quotes/pages/ に控える（2回目からは控えを読む）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CACHE = join(ROOT, 'state/quotes/pages');
const USER_AGENT = 'Mozilla/5.0 (compatible; Bayesian-chara-picker quote check)';
const OUR_AGENTS = ['*', 'claudebot', 'claude-user', 'claude-searchbot', 'claude-web', 'anthropic-ai'];
const HOST_INTERVAL_MS = 2000;
// 2秒でも速すぎると返したホスト（2026-10-30 に wikiwiki.jp が 429 を返した）。
const HOST_MIN_INTERVAL_MS = { 'wikiwiki.jp': 10000 };
const TIMEOUT_MS = 20000;
const MAX_BYTES = 4 * 1024 * 1024;

/** apply.mjs の loose と同じ（句読点・記号・長音・空白の揺れを除く）。 */
const LOOSE_DROP = /[\s!?！？…‥・.,、。〜~ー\-—―☆\u266A「」『』]/g;
export const loose = (s) => String(s ?? '').normalize('NFKC').replace(LOOSE_DROP, '');
/** キャラの名前。「・」や空白で区切った一部も含める（ページでは姓か名だけのことが多い）。 */
export const namesOf = (ch) => [ch.name, ...ch.aliases, ...ch.name.split(/[・\s\u3000]/)].filter((n) => loose(n).length >= 2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastHit = new Map();
const hostDelay = new Map();
async function politeFetch(url) {
  const host = new URL(url).host;
  const interval = Math.max(hostDelay.get(host) ?? HOST_INTERVAL_MS, HOST_MIN_INTERVAL_MS[host] ?? 0);
  const wait = (lastHit.get(host) ?? 0) + interval - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ja,en;q=0.5' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const buf = Buffer.from(await res.arrayBuffer()).subarray(0, MAX_BYTES);
  return { status: res.status, type: res.headers.get('content-type') ?? '', buf };
}

/** 自分に当たる組（* と Claude・Anthropic のクローラー）の規則をすべて集める。どれか1つが禁じれば取らない。 */
export function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length || current.delay !== null) {
        current = { agents: [], rules: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && (key === 'allow' || key === 'disallow')) {
      if (value) current.rules.push({ allow: key === 'allow', path: value });
    } else if (current && key === 'crawl-delay') {
      current.delay = Number(value) || null;
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => OUR_AGENTS.includes(a)));
  return {
    groups: mine.map((g) => g.rules),
    delay: Math.max(0, ...mine.map((g) => g.delay ?? 0)),
  };
}

/** robots.txt のパスを正規表現にする（* は任意の文字列、末尾の $ は終わり）。 */
const toRegex = (path) => new RegExp(`^${path.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}`);

export function allowedBy(robots, url) {
  const u = new URL(url);
  const path = decodeURI(u.pathname) + u.search;
  const rawPath = u.pathname + u.search;
  return robots.groups.every((rules) => {
    let best = null;
    for (const rule of rules) {
      const re = toRegex(rule.path);
      if ((re.test(path) || re.test(rawPath)) && (!best || rule.path.length > best.path.length)) best = rule;
    }
    return !best || best.allow;
  });
}

const robotsCache = new Map();
async function robotsFor(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    let robots = { groups: [], delay: 0 };
    try {
      const r = await politeFetch(`${u.origin}/robots.txt`);
      if (r.status === 200) robots = parseRobots(r.buf.toString('utf8'));
    } catch {
      // robots.txt が取れないときは、禁止の指定が無いものとして扱う。
    }
    if (robots.delay) hostDelay.set(u.host, Math.max(HOST_INTERVAL_MS, robots.delay * 1000));
    robotsCache.set(u.origin, robots);
  }
  return robotsCache.get(u.origin);
}

function decode(buf, type) {
  const head = buf.subarray(0, 4096).toString('latin1');
  const charset = (type.match(/charset=([\w-]+)/i) ?? head.match(/<meta[^>]+charset=["']?([\w-]+)/i) ?? [])[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset.toLowerCase()).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', thinsp: ' ', hellip: '…' };
export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(rt|rp)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|p|div|li|tr|td|th|h[1-6]|dt|dd)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? all;
    })
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n');
}

/**
 * ページの本文。{ status: 'ok', text } | { status: 'blocked' } | { status: 'error', http?, message? }。
 */
export async function readPage(url) {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, `${createHash('sha1').update(url).digest('hex')}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  let page;
  if (!allowedBy(await robotsFor(url), url)) page = { status: 'blocked' };
  else {
    try {
      const r = await politeFetch(url);
      page = r.status === 200 ? { status: 'ok', text: htmlToText(decode(r.buf, r.type)) } : { status: 'error', http: r.status };
    } catch (e) {
      page = { status: 'error', message: String(e?.message ?? e) };
    }
  }
  // 取得が速すぎる・一時的に落ちている、の答えは控えず、次に回したときに取り直す。
  if (page.http !== 429 && page.http !== 503) writeFileSync(file, `${JSON.stringify({ url, ...page })}\n`);
  return page;
}

/** 本文を loose にした文字列と、その各文字が元の本文の何文字目かの対応。 */
export function looseWithMap(text) {
  let out = '';
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const piece = loose(text[i]);
    for (let k = 0; k < piece.length; k++) map.push(i);
    out += piece;
  }
  return { out, map };
}
