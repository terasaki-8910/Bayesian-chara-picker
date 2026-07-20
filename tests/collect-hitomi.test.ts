import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  REQUEST_DELAY_MS,
  USER_AGENT,
  buildNozomiUrl,
  countForHitomiQuery,
  createHitomiFetcher,
  parseNozomiIds,
} from '../scripts/collect-hitomi.mjs';

/** nozomi 形式: ビッグエンディアン i32 の配列。テスト用に手で組み立てる。 */
function nozomiBuffer(ids: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(ids.length * 4);
  const view = new DataView(buf);
  ids.forEach((id, i) => view.setInt32(i * 4, id, false));
  return buf;
}

function okResponse(ids: number[]) {
  return { ok: true, status: 200, arrayBuffer: async () => nozomiBuffer(ids) };
}

function notFoundResponse() {
  return { ok: false, status: 404, arrayBuffer: async () => nozomiBuffer([]) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('hitomi.la 収集スクリプトの規約遵守', () => {
  it('スペースは %20 でエンコードする（_ や + ではない。実測で確認済み）', () => {
    const url = buildNozomiUrl({ area: 'character', tag: 'narberal gamma' });
    expect(url).toBe('https://ltn.gold-usergeneratedcontent.net/n/character/narberal%20gamma-all.nozomi');
  });

  it('area が character / series で正しく切り替わる', () => {
    expect(buildNozomiUrl({ area: 'series', tag: 'azur lane' })).toBe(
      'https://ltn.gold-usergeneratedcontent.net/n/series/azur%20lane-all.nozomi',
    );
  });

  it('parseNozomiIds: ビッグエンディアン i32 の配列を集合に変換する', () => {
    const ids = parseNozomiIds(nozomiBuffer([1, 2, 3, 4063556]));
    expect(ids).toEqual(new Set([1, 2, 3, 4063556]));
  });

  it('countForHitomiQuery: series 未指定なら character タグの件数をそのまま使う', async () => {
    const fetchImpl = vi.fn(async () => okResponse([10, 20, 30]));
    const fetcher = createHitomiFetcher({ fetchImpl, delayMs: 0 });
    const result = await countForHitomiQuery(fetcher, { character: 'rem', series: null }, new Map());
    expect(result).toEqual({ galleryCount: 3, seriesFilter: null });
  });

  it('countForHitomiQuery: series 指定時は character と series の積集合を使う（他作品同名キャラの誤カウント対策）', async () => {
    // yamato: 3件（One Pieceのヤマトを含む想定） / azur lane series: そのうち2件だけが実際に該当。
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/character/')) return okResponse([1, 2, 3]);
      if (url.includes('/series/')) return okResponse([2, 3, 999]);
      throw new Error(`unexpected url: ${url}`);
    });
    const fetcher = createHitomiFetcher({ fetchImpl, delayMs: 0 });
    const result = await countForHitomiQuery(
      fetcher,
      { character: 'yamato', series: 'azur lane' },
      new Map(),
    );
    expect(result).toEqual({ galleryCount: 2, seriesFilter: 'azur lane' });
  });

  it('countForHitomiQuery: series タグの取得は同一実行内でキャッシュされる（2 回呼んでも fetch は 3 回）', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/character/')) return okResponse([1, 2]);
      return okResponse([1, 2]);
    });
    const fetcher = createHitomiFetcher({ fetchImpl, delayMs: 0 });
    const cache = new Map();
    await countForHitomiQuery(fetcher, { character: 'nagato', series: 'azur lane' }, cache);
    await countForHitomiQuery(fetcher, { character: 'yamato', series: 'azur lane' }, cache);
    // character:nagato + character:yamato + series:azur_lane(1回だけ) = 3
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('存在しないタグ（404）は空集合として扱う（エラーにしない）', async () => {
    const fetchImpl = vi.fn(async () => notFoundResponse());
    const fetcher = createHitomiFetcher({ fetchImpl, delayMs: 0 });
    const result = await countForHitomiQuery(fetcher, { character: 'nonexistent-tag', series: null }, new Map());
    expect(result).toEqual({ galleryCount: 0, seriesFilter: null });
  });

  it('404 以外の異常ステータスはエラーにする', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, arrayBuffer: async () => nozomiBuffer([]) }));
    const fetcher = createHitomiFetcher({ fetchImpl, delayMs: 0 });
    await expect(
      countForHitomiQuery(fetcher, { character: 'rem', series: null }, new Map()),
    ).rejects.toThrow(/status=500/);
  });

  it('リクエスト間隔が REQUEST_DELAY_MS 以上あく', async () => {
    vi.useFakeTimers();
    const calledAt: number[] = [];
    const fetchImpl = async () => {
      calledAt.push(Date.now());
      return okResponse([]);
    };
    const fetcher = createHitomiFetcher({ fetchImpl, delayMs: REQUEST_DELAY_MS });

    const done = (async () => {
      await fetcher('https://example.test/1/');
      await fetcher('https://example.test/2/');
    })();
    await vi.advanceTimersByTimeAsync(5 * REQUEST_DELAY_MS);
    await done;

    expect(calledAt).toHaveLength(2);
    expect(calledAt[1] - calledAt[0]).toBeGreaterThanOrEqual(REQUEST_DELAY_MS);
  });

  it('User-Agent が空でなく、連絡手段を含む', () => {
    expect(typeof USER_AGENT).toBe('string');
    expect(USER_AGENT).toMatch(/(mailto:|https?:\/\/|[^\s@]+@[^\s@]+\.[^\s@]+)/);
  });

  it('User-Agent ヘッダを実際に送る（DLsite用のUAで上書きされない）', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers);
      return okResponse([]);
    };
    const fetcher = createHitomiFetcher({ fetchImpl, delayMs: 0 });
    await fetcher('https://example.test/1/');
    const ua = Object.entries(seen[0]).find(([k]) => k.toLowerCase() === 'user-agent')?.[1];
    expect(ua).toBe(USER_AGENT);
  });

  it('import しただけでは外部通信しない（収集はアプリ実行時に走らない）', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    await import('../scripts/collect-hitomi.mjs');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
