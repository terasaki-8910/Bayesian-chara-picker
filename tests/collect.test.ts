import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CRAWL_DELAY_MS,
  PER_PAGE,
  USER_AGENT,
  buildSearchUrl,
  collectCharacter,
  createPoliteFetcher,
  estimateRange,
  parseSearchResult,
} from '../scripts/collect.mjs';
import { supplyFileSchema } from '../src/data/schema';
import { readText } from './helpers/data';

const multiPage = readText('tests/fixtures/search-multi-page.html');
const singlePage = readText('tests/fixtures/search-single-page.html');
const zeroHit = readText('tests/fixtures/search-zero-hit.html');
const allAi = readText('tests/fixtures/search-single-page-all-ai.html');

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
    // 1 ページに収まる場合は推定ではなく実数が確定する。AI 生成作品もこの件数に含まれる。
    expect(result.estimatedRange).toEqual([17, 17]);
  });

  it('B7: estimateRange の境界', () => {
    expect(estimateRange({ pageCount: 0, itemsOnFirstPage: 0, perPage: 30 })).toEqual([0, 0]);
    expect(estimateRange({ pageCount: 1, itemsOnFirstPage: 30, perPage: 30 })).toEqual([30, 30]);
    expect(estimateRange({ pageCount: 2, itemsOnFirstPage: 30, perPage: 30 })).toEqual([31, 60]);
  });

  it('B8: 結果リストが 2 つある実ページ構造（骨組み + 表示側）で表示側を数える', () => {
    // 前提の固定: フィクスチャが実物と同じく id="search_result_list" を 2 つ持ち、先頭が骨組み。
    for (const html of [multiPage, singlePage, zeroHit, allAi]) {
      const opens = html.match(/<div[^>]*\bid="search_result_list"[^>]*>/g) ?? [];
      expect(opens).toHaveLength(2);
      expect(opens[0]).toContain('loading_display"');
      expect(opens[1]).toContain('loading_display_open');
    }
    // 1 つ目（骨組み）だけを見る旧実装は、1 ページ以内の結果を 0 件にしてしまう。
    expect(parseSearchResult(singlePage).itemsOnFirstPage).toBeGreaterThan(0);
    expect(parseSearchResult(allAi).pageCount).toBe(1);
  });

  it('B8: 表示側の選択は並び順にも class 名にも依存しない', () => {
    const skeleton = '<div id="search_result_list" class="loading_display" style="display: none;"><div class="skel"></div></div>';
    const display = (cls: string) =>
      `<div id="search_result_list" class="${cls}"><ul><li data-list_item_product_id="RJ01000001"></li><li data-list_item_product_id="RJ01000002"></li></ul></div>`;

    const displayFirst = `${display('loading_display_open')}${skeleton}`;
    expect(parseSearchResult(displayFirst).itemsOnFirstPage).toBe(2);

    // class 名が変わっても、作品を持つ方を選ぶ。
    const renamed = `${skeleton}${display('some_future_class')}`;
    expect(parseSearchResult(renamed).itemsOnFirstPage).toBe(2);
  });

  it('B8: RJ 以外の作品 ID（BJ 書籍・VJ ソフト）も 1 ページ目の件数に数える', () => {
    // 前提の固定: フィクスチャに BJ / VJ が 1 件ずつ入っている。
    expect(singlePage.match(/data-list_item_product_id="(?:BJ|VJ)\d+"/g)).toHaveLength(2);
    expect(parseSearchResult(singlePage).itemsOnFirstPage).toBe(17);
  });

  it('B8: 作品行の中に入れ子の ul/li があっても 1 作品を二重に数えない', () => {
    // フィクスチャの作品行は <li> の中にカート操作の <ul><li> を持つ。
    expect(multiPage).toContain('class="work_operation_btn');
    expect(parseSearchResult(multiPage).itemsOnFirstPage).toBe(30);
  });

  it('B9: AI 生成作品を件数とは別に数える', () => {
    const multi = parseSearchResult(multiPage, { perPage: PER_PAGE });
    expect(multi.aiOnFirstPage).toBe(19);
    // 件数の意味は変わらない: AI 生成を含んだまま 30 件・12 ページ。
    expect(multi.itemsOnFirstPage).toBe(30);
    expect(multi.pageCount).toBe(12);
    expect(multi.estimatedRange).toEqual([331, 360]);

    const single = parseSearchResult(singlePage, { perPage: PER_PAGE });
    expect(single.aiOnFirstPage).toBe(6);
    expect(single.itemsOnFirstPage).toBe(17);
    expect(single.estimatedRange).toEqual([17, 17]);

    const all = parseSearchResult(allAi, { perPage: PER_PAGE });
    expect(all.aiOnFirstPage).toBe(5);
    expect(all.itemsOnFirstPage).toBe(5);

    const zero = parseSearchResult(zeroHit, { perPage: PER_PAGE });
    expect(zero.aiOnFirstPage).toBe(0);
  });

  it('B9: AI 生成の判定は /aix/ URL と AIG 属性のどちらか一方でも拾う', () => {
    const li = (id: string, inner: string) => `<li data-list_item_product_id="${id}">${inner}</li>`;
    const list = [
      li('RJ01000001', '<a href="https://www.dlsite.com/aix/work/=/product_id/RJ01000001.html">x</a>'),
      li(
        'RJ01000002',
        '<input type="hidden" class="__product_attributes" name="__product_attributes" id="_RJ01000002" value="RG1,adl,male,AIG,JPN" disabled="disabled">',
      ),
      li('RJ01000003', '<a href="https://www.dlsite.com/maniax/work/=/product_id/RJ01000003.html">x</a>'),
      // AIG に似た別トークンは AI 生成ではない。
      li(
        'RJ01000004',
        '<input type="hidden" class="__product_attributes" name="__product_attributes" id="_RJ01000004" value="RG1,adl,male,AIGX,XAIG" disabled="disabled">',
      ),
    ].join('');
    const result = parseSearchResult(`<div id="search_result_list">${list}</div>`);
    expect(result.itemsOnFirstPage).toBe(4);
    expect(result.aiOnFirstPage).toBe(2);
  });

  it('B9: 結果リストの外（推薦枠）にある /aix/ リンクは AI 生成の数に入れない', () => {
    const html = `<div id="search_result_list"><li data-list_item_product_id="RJ01000001"><a href="https://www.dlsite.com/maniax/work/=/product_id/RJ01000001.html">x</a></li></div>
      <div id="recommend"><a href="https://www.dlsite.com/aix/work/=/product_id/RJ01000001.html">x</a><a href="https://www.dlsite.com/aix/work/=/product_id/RJ09999999.html">y</a></div>`;
    const result = parseSearchResult(html);
    expect(result.itemsOnFirstPage).toBe(1);
    expect(result.aiOnFirstPage).toBe(0);
  });

  it('B10: 結果リスト自体が見つからないページは 0 件と誤認せずエラーにする', () => {
    expect(() => parseSearchResult('<html><body>Just a moment...</body></html>')).toThrow(/search_result_list/);
  });

  it('B10: 複数ページと言いながら 1 ページ目の作品を読めないときはエラーにする', () => {
    // 骨組みを掴む不具合では、pageCount だけ正しく出て itemsOnFirstPage が 0 のままになっていた。
    const html = `<div id="search_result_list" class="loading_display_open"></div>
      <a href="/maniax/fsr/=/keyword/x/per_page/30/page/5/">最後へ</a>`;
    expect(() => parseSearchResult(html)).toThrow(/1 ページ目/);
  });

  it('B11: 1 キャラの収集結果は従来の件数フィールドの意味を保ち、firstPage を別に持つ', async () => {
    const urls: string[] = [];
    const politeFetch = async (url: string) => {
      urls.push(url);
      // 全体は 12 ページ（AI 19/30）、work_type を絞った 3 本は 1 ページに収まる 17 件。
      const html = url.includes('work_type_category') ? singlePage : multiPage;
      return { ok: true, status: 200, text: async () => html };
    };
    const entry = await collectCharacter(politeFetch, { dlsiteQuery: 'テスト' });

    expect(urls).toHaveLength(4);
    expect(entry.pageCount).toBe(12);
    expect(entry.estimatedRange).toEqual([331, 360]);
    // byWorkType は pageCount の意味のまま（1 ページに収まるなら 1。旧実装は 0 になっていた）。
    expect(entry.byWorkType).toEqual({ doujinshi: 1, voice: 1, game: 1 });
    expect(entry.firstPage).toEqual({ items: 30, aiGenerated: 19 });
    expect(entry.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('B11: supply のスキーマは firstPage を任意で受け付け、内数が件数を超える値は弾く', () => {
    const base = {
      pageCount: 1,
      estimatedRange: [17, 17],
      byWorkType: { doujinshi: 1, voice: 0, game: 0 },
      fetchedAt: '2026-10-05T00:00:00.000Z',
      hitomi: null,
    };
    // 収集し直す前の既存エントリ（firstPage なし）はそのまま通る。
    expect(supplyFileSchema.safeParse({ a: base }).success).toBe(true);
    expect(supplyFileSchema.safeParse({ a: { ...base, firstPage: { items: 17, aiGenerated: 6 } } }).success).toBe(true);
    expect(supplyFileSchema.safeParse({ a: { ...base, firstPage: { items: 5, aiGenerated: 6 } } }).success).toBe(false);
    expect(supplyFileSchema.safeParse({ a: { ...base, firstPage: { items: 5, aiGenerated: -1 } } }).success).toBe(false);
    expect(supplyFileSchema.safeParse({ a: { ...base, firstPage: { items: 5 } } }).success).toBe(false);
  });

  it('import しただけでは外部通信しない（収集はアプリ実行時に走らない）', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    await import('../scripts/collect.mjs');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
