import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  REQUEST_DELAY_MS,
  USER_AGENT,
  countPosts,
  createDanbooruFetcher,
  fetchPostsPage,
  fetchTagExact,
  searchCharacterTagCandidates,
  splitTagString,
} from '../scripts/bayes/danbooru-client.mjs';
import { mapOneCharacter, seriesOverlapRatio, toBareTag } from '../scripts/bayes/map-characters.mjs';
import { runVerifyChecks, samplePostsForTag } from '../scripts/bayes/sample-posts.mjs';
import {
  AXIS_MULTI_EXCLUDES,
  AXIS_MULTI_INCLUDES,
  AXIS_SINGLE_MATCH,
  AXIS_SINGLE_MISMATCH,
  DEFAULT_EPSILON,
  clamp01,
  computeBinaryTheta,
  computeGroupBaseRate,
  estimateAxisMultiLikelihood,
  estimateAxisSingleLikelihood,
  estimateBinaryLikelihood,
  estimateBinaryRawRate,
  estimateGroupLikelihood,
  logit,
  mergeLikelihoods,
  sigmoid,
} from '../scripts/bayes/estimators.mjs';

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BB. Danbooruクライアント（scripts/bayes/danbooru-client.mjs）', () => {
  it('リクエスト間隔が REQUEST_DELAY_MS 以上あく（既存 collect-hitomi.mjs と同じ規約）', async () => {
    vi.useFakeTimers();
    const calledAt: number[] = [];
    const fetchImpl = async () => {
      calledAt.push(Date.now());
      return jsonResponse([]);
    };
    const fetcher = createDanbooruFetcher({ fetchImpl, delayMs: REQUEST_DELAY_MS });

    const done = (async () => {
      await fetcher('/tags.json?search[name]=a');
      await fetcher('/tags.json?search[name]=b');
    })();
    await vi.advanceTimersByTimeAsync(5 * REQUEST_DELAY_MS);
    await done;

    expect(calledAt).toHaveLength(2);
    expect(calledAt[1] - calledAt[0]).toBeGreaterThanOrEqual(REQUEST_DELAY_MS);
  });

  it('User-Agent ヘッダを実際に送る', async () => {
    const seen: Array<{ headers?: Record<string, string> }> = [];
    const fetchImpl = async (_url: string, init?: { headers?: Record<string, string> }) => {
      seen.push(init ?? {});
      return jsonResponse([]);
    };
    const fetcher = createDanbooruFetcher({ fetchImpl, delayMs: 0 });
    await fetcher('/tags.json');
    expect(seen[0].headers?.['User-Agent']).toBe(USER_AGENT);
  });

  it('User-Agent が空でなく、連絡手段を含む', () => {
    expect(typeof USER_AGENT).toBe('string');
    expect(USER_AGENT).toMatch(/(mailto:|https?:\/\/|[^\s@]+@[^\s@]+\.[^\s@]+)/);
  });

  it('APIルートを前置してURLを組み立てる', async () => {
    const seenUrls: string[] = [];
    const fetchImpl = async (url: string) => {
      seenUrls.push(url);
      return jsonResponse([]);
    };
    const fetcher = createDanbooruFetcher({ fetchImpl, delayMs: 0 });
    await fetcher('/tags.json?search[name]=rem');
    expect(seenUrls[0]).toBe('https://danbooru.donmai.us/tags.json?search[name]=rem');
  });

  it('ok:false のレスポンスはエラーにする', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const fetcher = createDanbooruFetcher({ fetchImpl, delayMs: 0 });
    await expect(fetcher('/tags.json')).rejects.toThrow(/status=500/);
  });

  it('fetchTagExact: search[name]の完全一致で1件目を返す、無ければnull', async () => {
    const fetchImpl = async (url: string) => {
      if (url.includes('search%5Bname%5D=hong_meiling') || url.includes('search[name]=hong_meiling')) {
        return jsonResponse([{ name: 'hong_meiling', category: 4, post_count: 27851 }]);
      }
      return jsonResponse([]);
    };
    const fetcher = createDanbooruFetcher({ fetchImpl, delayMs: 0 });
    expect(await fetchTagExact(fetcher, 'hong_meiling')).toEqual({ name: 'hong_meiling', category: 4, post_count: 27851 });
    expect(await fetchTagExact(fetcher, 'nonexistent_tag')).toBeNull();
  });

  it('searchCharacterTagCandidates: category=4・order=countを指定する', async () => {
    let seenUrl = '';
    const fetchImpl = async (url: string) => {
      seenUrl = url;
      return jsonResponse([{ name: 'rem_(re:zero)', category: 4, post_count: 10061 }]);
    };
    const fetcher = createDanbooruFetcher({ fetchImpl, delayMs: 0 });
    const result = await searchCharacterTagCandidates(fetcher, 'rem');
    expect(seenUrl).toContain('search[category]=4');
    expect(seenUrl).toContain('search[order]=count');
    expect(result).toEqual([{ name: 'rem_(re:zero)', category: 4, post_count: 10061 }]);
  });

  it('countPosts: counts.postsを返す', async () => {
    const fetchImpl = async () => jsonResponse({ counts: { posts: 3292 } });
    const fetcher = createDanbooruFetcher({ fetchImpl, delayMs: 0 });
    expect(await countPosts(fetcher, ['taihou_(kancolle)', 'kantai_collection'])).toBe(3292);
  });

  it('fetchPostsPage: id,tag_string_generalのみに絞る（only=）', async () => {
    let seenUrl = '';
    const fetchImpl = async (url: string) => {
      seenUrl = url;
      return jsonResponse([{ id: 1, tag_string_general: 'blue_hair maid' }]);
    };
    const fetcher = createDanbooruFetcher({ fetchImpl, delayMs: 0 });
    const posts = await fetchPostsPage(fetcher, 'rem_(re:zero)', { page: 2, limit: 200 });
    expect(seenUrl).toContain('only=id,tag_string_general');
    expect(seenUrl).toContain('page=2');
    expect(seenUrl).toContain('limit=200');
    expect(posts).toEqual([{ id: 1, tag_string_general: 'blue_hair maid' }]);
  });

  it('splitTagString: スペース区切りを配列にする、空文字列は空配列', () => {
    expect(splitTagString('blue_hair maid smile')).toEqual(['blue_hair', 'maid', 'smile']);
    expect(splitTagString('')).toEqual([]);
  });

  it('import しただけでは外部通信しない', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    await import('../scripts/bayes/danbooru-client.mjs');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('BB. 尤度推定の純粋関数（scripts/bayes/estimators.mjs）', () => {
  it('clamp01: [epsilon, 1-epsilon] の範囲に丸める', () => {
    expect(clamp01(-1, 0.02)).toBe(0.02);
    expect(clamp01(2, 0.02)).toBe(0.98);
    expect(clamp01(0.5, 0.02)).toBe(0.5);
  });

  it('logit/sigmoid: 互いに逆関数である', () => {
    for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      expect(sigmoid(logit(p))).toBeCloseTo(p, 10);
    }
  });

  it('estimateGroupLikelihood: n_G=0ならp=b_qへ縮退する（データ無し=無情報化）', () => {
    expect(estimateGroupLikelihood({ k_q: 0, n_G: 0, b_q: 0.31 })).toBeCloseTo(0.31, 10);
  });

  it('estimateGroupLikelihood: サンプルが十分あれば生の比率に近づく', () => {
    // 紅美鈴の実測に近い比: red_hair 15378 / hong_meiling全体27851 のオーダー感を模した例
    const p = estimateGroupLikelihood({ k_q: 900, n_G: 1000, b_q: 0.2, K: 10 });
    expect(p).toBeGreaterThan(0.85); // K=10のオフセットはあるが十分大サンプルなら生率に近い
    expect(p).toBeLessThan(0.9);
  });

  it('estimateGroupLikelihood: k_q>n_G は例外', () => {
    expect(() => estimateGroupLikelihood({ k_q: 5, n_G: 3, b_q: 0.1 })).toThrow();
  });

  it('computeGroupBaseRate: 全キャラ合計のk_q/n_Gを返す', () => {
    const rate = computeGroupBaseRate([
      { k_q: 10, n_G: 40 },
      { k_q: 5, n_G: 10 },
    ]);
    expect(rate).toBeCloseTo(15 / 50, 10);
  });

  it('computeGroupBaseRate: 全員n_G=0なら0', () => {
    expect(computeGroupBaseRate([{ k_q: 0, n_G: 0 }])).toBe(0);
  });

  it('estimateBinaryRawRate: ラプラス平滑化込みの比率', () => {
    expect(estimateBinaryRawRate({ k_t: 0, n_c: 0 })).toBeCloseTo(0.5, 10);
    expect(estimateBinaryRawRate({ k_t: 100, n_c: 100 })).toBeGreaterThan(0.9);
  });

  it('computeBinaryTheta: P95相当の値・下限0.05を下回らない', () => {
    const rates = Array.from({ length: 100 }, (_, i) => i / 100); // 0.00〜0.99
    const theta = computeBinaryTheta(rates);
    expect(theta).toBeGreaterThanOrEqual(0.9);
    expect(computeBinaryTheta([])).toBe(0.05);
    expect(computeBinaryTheta([0.01, 0.02])).toBe(0.05); // 床を下回らない
  });

  it('estimateBinaryLikelihood: 生率をthetaで割ってクランプする', () => {
    // 眼鏡タグが全体の8%にしか付かない(theta=0.08)キャラで、実際にk_t/n_cが8%なら
    // 「眼鏡をかけている」との整合が高い(p≈1近く)になるべき
    const p = estimateBinaryLikelihood({ k_t: 80, n_c: 1000, theta: 0.08 });
    expect(p).toBeGreaterThan(0.9);
  });

  it('estimateBinaryLikelihood: theta<=0は例外', () => {
    expect(() => estimateBinaryLikelihood({ k_t: 1, n_c: 10, theta: 0 })).toThrow();
  });

  it('estimateAxisSingleLikelihood: 一致0.9・不一致0.1・空欄null', () => {
    expect(estimateAxisSingleLikelihood('クール', 'クール')).toBe(AXIS_SINGLE_MATCH);
    expect(estimateAxisSingleLikelihood('元気', 'クール')).toBe(AXIS_SINGLE_MISMATCH);
    expect(estimateAxisSingleLikelihood(null, 'クール')).toBeNull();
    expect(estimateAxisSingleLikelihood('', 'クール')).toBeNull();
  });

  it('estimateAxisMultiLikelihood: 含む0.9・含まず0.2・空配列null', () => {
    expect(estimateAxisMultiLikelihood(['眼鏡', '長髪'], '眼鏡')).toBe(AXIS_MULTI_INCLUDES);
    expect(estimateAxisMultiLikelihood(['長髪'], '眼鏡')).toBe(AXIS_MULTI_EXCLUDES);
    expect(estimateAxisMultiLikelihood([], '眼鏡')).toBeNull();
  });

  it('mergeLikelihoods: 有効ソースが無ければfallbackを返す', () => {
    expect(mergeLikelihoods([], 0.31)).toBeCloseTo(0.31, 10);
    expect(mergeLikelihoods([{ p: null, weight: 10 }], 0.31)).toBeCloseTo(0.31, 10);
    expect(mergeLikelihoods([{ p: 0.9, weight: 0 }], 0.31)).toBeCloseTo(0.31, 10);
  });

  it('mergeLikelihoods: 重みが大きいソースに強く引っ張られる', () => {
    // n_eff=1000のdanbooru p=0.9 と、W_AXIS=30のaxis p=0.1 → danbooru側にほぼ張り付く
    const merged = mergeLikelihoods(
      [
        { p: 0.9, weight: 1000 },
        { p: 0.1, weight: 30 },
      ],
      0.5,
    );
    expect(merged).toBeGreaterThan(0.85);
  });

  it('mergeLikelihoods: 単一ソースならepsilonクランプ後のその値に等しい', () => {
    const merged = mergeLikelihoods([{ p: 0.9, weight: 30 }], 0.5, { epsilon: DEFAULT_EPSILON });
    expect(merged).toBeCloseTo(0.9, 10);
  });

  it('mergeLikelihoods: 結果は常に[epsilon, 1-epsilon]の範囲', () => {
    const merged = mergeLikelihoods([{ p: 0.999999, weight: 1 }], 0.5);
    expect(merged).toBeLessThanOrEqual(1 - DEFAULT_EPSILON);
  });

  it('import しただけでは通信もファイルI/Oも発生しない', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    await import('../scripts/bayes/estimators.mjs');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * URLパターン→JSON応答のルーティングテーブルから danbooruFetch モックを作る。
 * `(` `)` `*` は encodeURIComponent でエスケープされない（`/` 等だけがされる）ため、
 * パターンは decodeURIComponent 後のURLに対して素直な文字列で書けるようにしてある。
 * マッチしないURLはテスト側の想定漏れなので明示的に例外にする（無言でnot-foundに
 * ならないようにするため）。
 */
function routedFetch(routes: Array<[RegExp, unknown]>) {
  return async (path: string) => {
    const decoded = decodeURIComponent(path);
    for (const [pattern, body] of routes) {
      if (pattern.test(decoded)) return body;
    }
    throw new Error(`テスト未定義のURL: ${decoded}`);
  };
}

describe('BB. キャラ→タグ導出の選定ロジック（scripts/bayes/map-characters.mjs）', () => {
  it('seriesOverlapRatio: seriesAlias無しはnull', async () => {
    const overlap = await seriesOverlapRatio(async () => ({ counts: { posts: 0 } }), { name: 'x', post_count: 10 }, null);
    expect(overlap).toBeNull();
  });

  it('seriesOverlapRatio: fallbackAliasがseriesAliasと同じなら余分な問い合わせをしない', async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return { counts: { posts: 5 } };
    };
    await seriesOverlapRatio(fetch, { name: 'x', post_count: 10 }, 'fate/grand_order', 'fate/grand_order');
    expect(calls).toBe(1);
  });

  it('seriesOverlapRatio: primaryが低くてもfallbackが高ければそちらを採用する（max）', async () => {
    const fetch = routedFetch([
      [/tags=x\+fate\/apocrypha/, { counts: { posts: 10 } }], // primary: 10/100=0.10
      [/tags=x\+fate_\(series\)/, { counts: { posts: 95 } }], // fallback: 95/100=0.95
    ]);
    const overlap = await seriesOverlapRatio(fetch, { name: 'x', post_count: 100 }, 'fate/apocrypha', 'fate_(series)');
    expect(overlap).toBeCloseTo(0.95, 10);
  });

  it('toBareTag: 小文字化しスペースをアンダースコアに変換する', () => {
    expect(toBareTag('Asuna Ichinose')).toBe('asuna_ichinose');
  });

  it('mapOneCharacter: overrideは共起検証をスキップしてそのまま採用する', async () => {
    const fetch = routedFetch([[/search\[name\]=forced_tag/, [{ name: 'forced_tag', category: 4, post_count: 42 }]]]);
    const result = await mapOneCharacter(
      fetch,
      { id: 'c1', series: '任意', hitomiQuery: { character: '無関係', series: null } },
      { overrides: { c1: { tag: 'forced_tag' } }, seriesAliases: {} },
    );
    expect(result).toMatchObject({ tag: 'forced_tag', postCount: 42, source: 'override' });
  });

  it('mapOneCharacter: override先が無効/0件ならtag=nullにする', async () => {
    const fetch = routedFetch([[/search\[name\]=dead_tag/, [{ name: 'dead_tag', category: 4, post_count: 0 }]]]);
    const result = await mapOneCharacter(
      fetch,
      { id: 'c1', series: '任意', hitomiQuery: { character: '無関係', series: null } },
      { overrides: { c1: { tag: 'dead_tag' } }, seriesAliases: {} },
    );
    expect(result.tag).toBeNull();
  });

  it('mapOneCharacter: 除外override（tag:null）はそのままtag:nullを返す', async () => {
    const fetch = routedFetch([]);
    const result = await mapOneCharacter(
      fetch,
      { id: 'c1', series: '任意', hitomiQuery: { character: '無関係', series: null } },
      { overrides: { c1: { tag: null, reason: '手動除外' } }, seriesAliases: {} },
    );
    expect(result).toMatchObject({ tag: null, reason: '手動除外', source: 'override' });
  });

  it('mapOneCharacter: どの手段でも候補ゼロならnot-found', async () => {
    const fetch = routedFetch([
      [/search\[name\]=/, []],
      [/search\[name_matches\]=/, []],
    ]);
    const result = await mapOneCharacter(
      fetch,
      { id: 'c1', series: '', hitomiQuery: { character: 'nobody_exists', series: null } },
      { overrides: {}, seriesAliases: {} },
    );
    expect(result).toMatchObject({ tag: null, source: 'not-found', reason: 'not-found' });
  });

  it('regression(bluearchive級): bare/反転/series修飾すべて失敗しても、先頭語(名のみ)のワイルドカードで解決する', async () => {
    // hitomiQuery「asuna ichinose」→ 実際のDanbooruタグは苗字ichinoseを含まない
    // asuna_(blue_archive)（2026-07-24、Blue Archive全8体で発覚した実パターン）。
    const fetch = routedFetch([
      [/search\[name\]=asuna_ichinose&/, []], // bare: 存在しない
      [/search\[name\]=ichinose_asuna&/, [{ name: 'ichinose_asuna', category: 4, post_count: 0 }]], // 反転: 無効スタブ
      [/search\[name\]=asuna_ichinose_\(blue_archive\)/, []], // series修飾: 存在しない
      [/search\[name_matches\]=asuna_ichinose\*/, []], // フルネームワイルドカード: 該当なし
      [/search\[name_matches\]=asuna\*/, [{ name: 'asuna_(blue_archive)', category: 4, post_count: 17911 }]], // 先頭語ワイルドカード
      [/counts\/posts\.json.*asuna_\(blue_archive\)/, { counts: { posts: 17911 } }], // 共起率100%
    ]);
    const result = await mapOneCharacter(
      fetch,
      { id: 'bluearchive-asuna-like', series: 'ブルーアーカイブ', hitomiQuery: { character: 'asuna ichinose', series: null } },
      { overrides: {}, seriesAliases: { ブルーアーカイブ: 'blue_archive' } },
    );
    expect(result.tag).toBe('asuna_(blue_archive)');
    expect(result.source).toBe('wildcard-verified');
    expect(result.seriesOverlap).toBeCloseTo(1, 10);
  });

  it('regression(アストルフォ/イリヤ級): 出自作品エイリアスの共起率が低くても、Fate傘タグ(fate_(series))との共起率が高ければ最多投稿の候補を正しく採用する', async () => {
    // 実際のアストルフォ: astolfo_(fate)=7585件はFate/Apocrypha個別タグとの共起は
    // 46%止まりだが、傘タグfate_(series)とは99.9%。傘フォールバックが無いと
    // 675件のastolfo_(memories_at_trifas)_(fate)という無関係候補に誤対応していた。
    const fetch = routedFetch([
      [/search\[name\]=astolfo&/, []],
      [/search\[name\]=astolfo_\(fate\/apocrypha\)/, []],
      [
        /search\[name_matches\]=astolfo\*/,
        [
          { name: 'astolfo_(fate)', category: 4, post_count: 7585 },
          { name: 'astolfo_(memories_at_trifas)_(fate)', category: 4, post_count: 675 },
        ],
      ],
      [/counts\/posts\.json\?tags=astolfo_\(fate\)\+fate\/apocrypha/, { counts: { posts: 3498 } }], // 46.1%
      [/counts\/posts\.json\?tags=astolfo_\(fate\)\+fate_\(series\)/, { counts: { posts: 7576 } }], // 99.9%
    ]);
    const result = await mapOneCharacter(
      fetch,
      { id: 'fate-astolfo-like', series: 'Fate/Apocrypha', hitomiQuery: { character: 'astolfo', series: null } },
      { overrides: {}, seriesAliases: { 'Fate/Apocrypha': 'fate/apocrypha' } },
    );
    expect(result.tag).toBe('astolfo_(fate)');
    expect(result.postCount).toBe(7585);
    expect(result.seriesOverlap).toBeGreaterThan(0.99);
  });

  it('regression(overlord-yuri級): exact一致は投稿数が少なくても、他作品の同名キャラ(ワイルドカード由来)より先に共起検証する', async () => {
    // 実際のユリ・アルファ: yuri_alpha(76件、exact)が正解だが、他作品の同名
    // キャラ(DDLC/テイルズ・オブ・ヴェスペリア等、数百〜千件超)がpost_count降順の
    // 上位5枠を占めると、共起率チェックすら受けられずnot-found/誤対応になっていた
    // （2026-07-24発覚）。exact/反転/series修飾はワイルドカードより優先して確認する。
    const fetch = routedFetch([
      [/search\[name\]=yuri_alpha&/, [{ name: 'yuri_alpha', category: 4, post_count: 76 }]],
      [/search\[name\]=yuri_alpha_\(overlord_\(maruyama\)\)/, []],
      [/search\[name_matches\]=yuri_alpha\*/, []],
      [
        /search\[name_matches\]=yuri\*/,
        [
          { name: 'yuri_(doki_doki_literature_club)', category: 4, post_count: 1738 },
          { name: 'yuri_lowell', category: 4, post_count: 1688 },
          { name: 'yuri_plisetsky', category: 4, post_count: 1012 },
          { name: 'yuri_sakazaki', category: 4, post_count: 927 },
          { name: 'yuri_briar', category: 4, post_count: 615 },
        ],
      ],
      [/counts\/posts\.json\?tags=yuri_alpha\+overlord_\(maruyama\)/, { counts: { posts: 76 } }], // 100%
    ]);
    const result = await mapOneCharacter(
      fetch,
      { id: 'overlord-yuri-like', series: 'オーバーロード', hitomiQuery: { character: 'yuri alpha', series: null } },
      { overrides: {}, seriesAliases: { オーバーロード: 'overlord_(maruyama)' } },
    );
    expect(result.tag).toBe('yuri_alpha');
    expect(result.postCount).toBe(76);
    expect(result.seriesOverlap).toBeCloseTo(1, 10);
  });

  it('Fate以外のシリーズでは傘タグフォールバックを一切問い合わせない', async () => {
    const seenPaths: string[] = [];
    const base = routedFetch([
      [/search\[name\]=x&/, [{ name: 'x', category: 4, post_count: 100 }]],
      [/search\[name\]=x_\(kantai_collection\)/, []],
      [/search\[name_matches\]=x\*/, []],
      [/counts\/posts\.json/, { counts: { posts: 90 } }],
    ]);
    const fetch = async (path: string) => {
      seenPaths.push(decodeURIComponent(path));
      return base(path);
    };
    await mapOneCharacter(
      fetch,
      { id: 'c1', series: '艦隊これくしょん', hitomiQuery: { character: 'x', series: null } },
      { overrides: {}, seriesAliases: { 艦隊これくしょん: 'kantai_collection' } },
    );
    expect(seenPaths.some((p) => p.includes('fate'))).toBe(false);
  });
});

function makePage(count: number, { startId = 1, tagString = 'blue_hair maid' } = {}) {
  return Array.from({ length: count }, (_, i) => ({ id: startId + i, tag_string_general: tagString }));
}

describe('BB. 投稿サンプリング（scripts/bayes/sample-posts.mjs）', () => {
  it('samplePostsForTag: ページが200件未満になった時点で打ち切る', async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      const page = calls === 1 ? makePage(200) : makePage(50, { startId: 1000 });
      return { ok: true, status: 200, json: async () => page };
    };
    const fetcher = createDanbooruFetcher({ fetchImpl: fetch, delayMs: 0 });
    const posts = await samplePostsForTag(fetcher, 'rem_(re:zero)');
    expect(calls).toBe(2); // 3〜5ページ目は取得しない
    expect(posts).toHaveLength(250);
  });

  it('samplePostsForTag: 全ページ満杯なら5ページ(1000件)まで取得する', async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => makePage(200) };
    };
    const fetcher = createDanbooruFetcher({ fetchImpl: fetch, delayMs: 0 });
    const posts = await samplePostsForTag(fetcher, 'popular_tag');
    expect(calls).toBe(5);
    expect(posts).toHaveLength(1000);
  });

  it('samplePostsForTag: tag_string_generalを配列に分割してid・tagsの形にする', async () => {
    const fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => [{ id: 42, tag_string_general: 'red_hair chinese_clothes smile' }],
    });
    const fetcher = createDanbooruFetcher({ fetchImpl: fetch, delayMs: 0 });
    const posts = await samplePostsForTag(fetcher, 'hong_meiling');
    expect(posts).toEqual([{ id: 42, tags: ['red_hair', 'chinese_clothes', 'smile'] }]);
  });

  it('runVerifyChecks: 紅美鈴のred_hairがgreen_hairの3倍を超えていればpass', () => {
    const cache = {
      tag: 'hong_meiling',
      posts: [
        ...Array.from({ length: 15378 / 100 }, () => ({ id: 1, tags: ['red_hair'] })),
        ...Array.from({ length: 1402 / 100 }, () => ({ id: 2, tags: ['green_hair'] })),
      ],
    };
    const results = runVerifyChecks((id) => (id === 'touhou-meiling' ? cache : null));
    expect(results).toEqual([expect.objectContaining({ id: 'touhou-meiling', pass: true })]);
  });

  it('runVerifyChecks: キャッシュ未取得ならfail', () => {
    const results = runVerifyChecks(() => null);
    expect(results[0]).toMatchObject({ pass: false });
    expect(results[0].detail).toContain('未取得');
  });

  it('runVerifyChecks: red_hairがgreen_hairの3倍に満たなければfail', () => {
    const cache = { tag: 'hong_meiling', posts: [{ id: 1, tags: ['red_hair'] }, { id: 2, tags: ['green_hair'] }] };
    const results = runVerifyChecks(() => cache);
    expect(results[0].pass).toBe(false);
  });

  it('import しただけでは通信もファイルI/Oも発生しない', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    await import('../scripts/bayes/sample-posts.mjs');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('BB. 尤度ビルド（scripts/bayes/build-likelihoods.mjs）', () => {
  it('import しただけでは通信もファイルI/Oも発生しない（mainはisMainModuleガード内）', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    await import('../scripts/bayes/build-likelihoods.mjs');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
