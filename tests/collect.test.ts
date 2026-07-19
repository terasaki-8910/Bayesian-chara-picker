import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CRAWL_DELAY_MS,
  PER_PAGE,
  USER_AGENT,
  buildSearchUrl,
  createPoliteFetcher,
  estimateRange,
  parseSearchResult,
} from '../scripts/collect.mjs';
import { readText } from './helpers/data';

const multiPage = readText('tests/fixtures/search-multi-page.html');
const singlePage = readText('tests/fixtures/search-single-page.html');
const zeroHit = readText('tests/fixtures/search-zero-hit.html');

/**
 * robots.txt のパターン表。SPEC 2.2 で実測確認した 2 行のみを固定する。
 * 推測で行を足さないこと（守れているかの判定が嘘になる）。
 * DLsite 側の robots.txt が変わったらここを更新して再検証する。
 */
const ROBOTS_RULES = [
  { type: 'disallow', path: '/*/fsr/=/*/per_page/*/page/' },
  { type: 'allow', path: '/*/fsr/=/*/per_page/*/page/1/' },
] as const;

/** robots.txt のパス表現（`*` 任意長 / `$` 終端）を正規表現に変換する。 */
function robotsPathToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const anchored = escaped.endsWith('\\$') ? `${escaped.slice(0, -2)}$` : escaped;
  return new RegExp(`^${anchored}`);
}

/**
 * 最長一致のルールを採用し、同長なら Allow を優先する（Google の robots 仕様）。
 * 該当ルールが無ければ許可。
 */
function isAllowedByRobots(url: string): boolean {
  const path = new URL(url).pathname;
  let best: { type: string; length: number } | null = null;
  for (const rule of ROBOTS_RULES) {
    if (!robotsPathToRegExp(rule.path).test(path)) continue;
    if (best === null || rule.path.length > best.length) {
      best = { type: rule.type, length: rule.path.length };
    } else if (rule.path.length === best.length && rule.type === 'allow') {
      best = { type: rule.type, length: rule.path.length };
    }
  }
  return best === null || best.type === 'allow';
}

const KEYWORDS = ['テストキャラ', 'a b c', '記号+と&', 'ASCIIName', '長い名前のキャラクター'];
const WORK_TYPES = [undefined, 'doujinshi', 'voice', 'game'] as const;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('B. 収集スクリプトの規約遵守', () => {
  it('B1: 生成される全 URL が /page/1/ で終わる', () => {
    for (const keyword of KEYWORDS) {
      for (const workType of WORK_TYPES) {
        const url = buildSearchUrl({ keyword, workType });
        expect(url, `keyword=${keyword} workType=${String(workType)}`).toMatch(/\/page\/1\/$/);
      }
    }
  });

  it('B1: 2 ページ目以降を作る余地が無い（page 指定は受け付けない）', () => {
    // 呼び出し側が page を渡しても、生成 URL は 1 ページ目のままでなければならない。
    const injected = buildSearchUrl({ keyword: 'テスト', page: 2 } as never);
    expect(injected).toMatch(/\/page\/1\/$/);
    expect(injected).not.toMatch(/\/page\/(?!1\/)\d+\//);
  });

  it('B1: keyword はエンコードされ、パス区切りを注入できない', () => {
    const url = buildSearchUrl({ keyword: 'a/../../page/9' });
    expect(url).toMatch(/\/page\/1\/$/);
    expect(url).not.toMatch(/\/page\/9\//);
  });

  it('B2: 生成 URL が robots.txt の Disallow に 1 件も一致しない', () => {
    for (const keyword of KEYWORDS) {
      for (const workType of WORK_TYPES) {
        const url = buildSearchUrl({ keyword, workType });
        expect(isAllowedByRobots(url), `robots で不許可: ${url}`).toBe(true);
      }
    }
  });

  it('B2: 判定器の逆確認 — page/2 の URL は Disallow と判定される', () => {
    // このネガティブコントロールが無いと、B2 は「常に true」でも通ってしまう。
    const pageTwo = buildSearchUrl({ keyword: 'テスト' }).replace(/\/page\/1\/$/, '/page/2/');
    expect(isAllowedByRobots(pageTwo)).toBe(false);
  });

  it('B3: 連続リクエストの間隔が 10 秒以上', async () => {
    expect(CRAWL_DELAY_MS).toBeGreaterThanOrEqual(10_000);
    vi.useFakeTimers();

    const calledAt: number[] = [];
    const fetchImpl = async (_url: string) => {
      calledAt.push(Date.now());
      return { ok: true, status: 200, text: async () => '' };
    };
    const politeFetch = createPoliteFetcher({ fetchImpl, delayMs: CRAWL_DELAY_MS });

    const done = (async () => {
      await politeFetch('https://example.test/1/');
      await politeFetch('https://example.test/2/');
      await politeFetch('https://example.test/3/');
    })();
    await vi.advanceTimersByTimeAsync(10 * CRAWL_DELAY_MS);
    await done;

    expect(calledAt).toHaveLength(3);
    expect(calledAt[1] - calledAt[0]).toBeGreaterThanOrEqual(CRAWL_DELAY_MS);
    expect(calledAt[2] - calledAt[1]).toBeGreaterThanOrEqual(CRAWL_DELAY_MS);
  });

  it('B4: User-Agent が空でなく、連絡手段を含む', () => {
    expect(typeof USER_AGENT).toBe('string');
    expect(USER_AGENT.trim().length).toBeGreaterThan(10);
    // メールアドレスか URL のいずれかが含まれていること。
    expect(USER_AGENT).toMatch(/(mailto:|https?:\/\/|[^\s@]+@[^\s@]+\.[^\s@]+)/);
  });

  it('B4: politeFetch が User-Agent ヘッダを実際に送る', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers);
      return { ok: true, status: 200, text: async () => '' };
    };
    const politeFetch = createPoliteFetcher({ fetchImpl, delayMs: 0 });
    await politeFetch('https://example.test/1/');

    expect(seen).toHaveLength(1);
    const ua = Object.entries(seen[0]).find(([k]) => k.toLowerCase() === 'user-agent')?.[1];
    expect(ua).toBe(USER_AGENT);
  });

  it('B5: 「最後へ」リンクから pageCount を取り出す', () => {
    const result = parseSearchResult(multiPage, { perPage: PER_PAGE });
    expect(result.pageCount).toBe(12);
    expect(result.estimatedRange).toEqual([331, 360]);
  });

  it('B6: 作品 ID の計数が search_result_list の内側に限定される', () => {
    // フィクスチャはページ全体で 72 個の作品 ID を含む（うち 42 個は推薦枠）。
    const naive = new Set(multiPage.match(/RJ\d{6,}/g) ?? []).size;
    expect(naive).toBe(72);

    const result = parseSearchResult(multiPage, { perPage: PER_PAGE });
    expect(result.itemsOnFirstPage).toBe(30);
  });

  it('B7: 0 件ページを 0 件と判定する', () => {
    const result = parseSearchResult(zeroHit, { perPage: PER_PAGE });
    expect(result.pageCount).toBe(0);
    expect(result.itemsOnFirstPage).toBe(0);
    expect(result.estimatedRange).toEqual([0, 0]);
  });

  it('B7: 1 ページに収まる件数を 0 件と取り違えない', () => {
    const result = parseSearchResult(singlePage, { perPage: PER_PAGE });
    expect(result.pageCount).toBe(1);
    expect(result.itemsOnFirstPage).toBe(17);
    // 1 ページに収まる場合は推定ではなく実数が確定する。
    expect(result.estimatedRange).toEqual([17, 17]);
  });

  it('B7: estimateRange の境界', () => {
    expect(estimateRange({ pageCount: 0, itemsOnFirstPage: 0, perPage: 30 })).toEqual([0, 0]);
    expect(estimateRange({ pageCount: 1, itemsOnFirstPage: 30, perPage: 30 })).toEqual([30, 30]);
    expect(estimateRange({ pageCount: 2, itemsOnFirstPage: 30, perPage: 30 })).toEqual([31, 60]);
  });

  it('import しただけでは外部通信しない（収集はアプリ実行時に走らない）', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    await import('../scripts/collect.mjs');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
