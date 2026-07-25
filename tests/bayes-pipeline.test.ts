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
  claimValuesOf,
  createWikidataFetcher,
  fetchEntity,
  fetchEntityLabels,
  searchEntity,
  REQUEST_DELAY_MS as WD_REQUEST_DELAY_MS,
  USER_AGENT as WD_USER_AGENT,
} from '../scripts/bayes/wikidata-client.mjs';
import {
  createNiconicoFetcher,
  extractRedirectPath,
  fetchArticleHtml,
  htmlToText,
  normalizeWhitespace,
  REQUEST_DELAY_MS as NC_REQUEST_DELAY_MS,
  USER_AGENT as NC_USER_AGENT,
} from '../scripts/bayes/niconico-client.mjs';
import { createOllamaClient, stripThinkTags } from '../scripts/bayes/ollama-client.mjs';
import {
  deriveAxisEnums,
  buildUserPrompt,
  verifyQuote,
  stripWrappingBrackets,
  extractOneCharacter,
} from '../scripts/bayes/llm-extract.mjs';
import {
  AXIS_MULTI_EXCLUDES,
  AXIS_MULTI_INCLUDES,
  AXIS_SINGLE_MATCH,
  AXIS_SINGLE_MISMATCH,
  DEFAULT_EPSILON,
  LLM_LIKELY_NO,
  LLM_LIKELY_YES,
  WIKIDATA_LIKELY_NO,
  WIKIDATA_LIKELY_YES,
  clamp01,
  computeBinaryTheta,
  computeGroupBaseRate,
  estimateAxisMultiLikelihood,
  estimateAxisSingleLikelihood,
  estimateBinaryLikelihood,
  estimateBinaryRawRate,
  estimateGroupLikelihood,
  estimateLlmLikelihood,
  estimateWikidataLikelihood,
  logit,
  mergeLikelihoods,
  sigmoid,
} from '../scripts/bayes/estimators.mjs';

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
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

describe('BB. Wikidataクライアント（scripts/bayes/wikidata-client.mjs）', () => {
  it('リクエスト間隔が REQUEST_DELAY_MS 以上あく', async () => {
    vi.useFakeTimers();
    const calledAt: number[] = [];
    const fetchImpl = async () => {
      calledAt.push(Date.now());
      return jsonResponse({ search: [] });
    };
    const fetcher = createWikidataFetcher({ fetchImpl, delayMs: WD_REQUEST_DELAY_MS });

    const done = (async () => {
      await fetcher('https://www.wikidata.org/w/api.php?a=1');
      await fetcher('https://www.wikidata.org/w/api.php?a=2');
    })();
    await vi.advanceTimersByTimeAsync(5 * WD_REQUEST_DELAY_MS);
    await done;

    expect(calledAt).toHaveLength(2);
    expect(calledAt[1] - calledAt[0]).toBeGreaterThanOrEqual(WD_REQUEST_DELAY_MS);
  });

  it('User-Agent ヘッダを送り、連絡手段を含む', async () => {
    const seen: Array<{ headers?: Record<string, string> }> = [];
    const fetchImpl = async (_url: string, init?: { headers?: Record<string, string> }) => {
      seen.push(init ?? {});
      return jsonResponse({});
    };
    const fetcher = createWikidataFetcher({ fetchImpl, delayMs: 0 });
    await fetcher('https://www.wikidata.org/w/api.php?a=1');
    expect(seen[0].headers?.['User-Agent']).toBe(WD_USER_AGENT);
    expect(WD_USER_AGENT).toMatch(/(mailto:|https?:\/\/|[^\s@]+@[^\s@]+\.[^\s@]+)/);
  });

  it('非JSON応答（レート制限時のプレーンテキスト応答）を検出してエラーにする', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => 'You are making too many requests to the API.',
      json: async () => {
        throw new Error('not reached');
      },
    });
    const fetcher = createWikidataFetcher({ fetchImpl, delayMs: 0 });
    await expect(fetcher('https://www.wikidata.org/w/api.php?a=1')).rejects.toThrow(/レート制限/);
  });

  it('ok:false のレスポンスはエラーにする', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, text: async () => '', json: async () => ({}) });
    const fetcher = createWikidataFetcher({ fetchImpl, delayMs: 0 });
    await expect(fetcher('https://www.wikidata.org/w/api.php?a=1')).rejects.toThrow(/status=500/);
  });

  it('searchEntity: wbsearchentities・language=ja・maxlagを指定する', async () => {
    let seenUrl = '';
    const fetchImpl = async (url: string) => {
      seenUrl = url;
      return jsonResponse({
        search: [{ id: 'Q117229504', display: { label: { value: 'Ichinose Asuna' } }, description: 'fictional character' }],
      });
    };
    const fetcher = createWikidataFetcher({ fetchImpl, delayMs: 0 });
    const result = await searchEntity(fetcher, '一之瀬アスナ');
    expect(seenUrl).toContain('action=wbsearchentities');
    expect(seenUrl).toContain('language=ja');
    expect(seenUrl).toContain('maxlag=');
    expect(result).toEqual([{ id: 'Q117229504', label: 'Ichinose Asuna', description: 'fictional character' }]);
  });

  it('fetchEntity: Special:EntityData/<qid>.json からclaims/labelsを取り出す', async () => {
    let seenUrl = '';
    const fetchImpl = async (url: string) => {
      seenUrl = url;
      return jsonResponse({ entities: { Q1: { claims: { P21: [] }, labels: { ja: { value: 'テスト' } } } } });
    };
    const fetcher = createWikidataFetcher({ fetchImpl, delayMs: 0 });
    const entity = await fetchEntity(fetcher, 'Q1');
    expect(seenUrl).toContain('Special:EntityData/Q1.json');
    expect(entity).toEqual({ qid: 'Q1', claims: { P21: [] }, labels: { ja: { value: 'テスト' } } });
  });

  it('fetchEntityLabels: 複数idを1リクエストでids=P1|P2バッチにし、ja/en両方を返す（片方しか無いエンティティにも対応）', async () => {
    let seenUrl = '';
    const fetchImpl = async (url: string) => {
      seenUrl = url;
      return jsonResponse({
        entities: {
          P21: { labels: { ja: { value: '性別' }, en: { value: 'sex or gender' } } },
          P1441: { labels: { en: { value: 'present in work' } } }, // jaラベル無しのケース
        },
      });
    };
    const fetcher = createWikidataFetcher({ fetchImpl, delayMs: 0 });
    const labels = await fetchEntityLabels(fetcher, ['P21', 'P1441']);
    expect(seenUrl).toContain('ids=P21%7CP1441');
    expect(labels).toEqual({
      P21: { ja: '性別', en: 'sex or gender' },
      P1441: { ja: '', en: 'present in work' },
    });
  });

  it('claimValuesOf: mainsnak.datavalueを取り出す。プロパティが無ければ空配列', () => {
    const entity = {
      qid: 'Q1',
      labels: {},
      claims: { P21: [{ mainsnak: { datavalue: { type: 'wikibase-entityid', value: { id: 'Q6581072' } } } }] },
    };
    expect(claimValuesOf(entity, 'P21')).toEqual([{ type: 'wikibase-entityid', value: { id: 'Q6581072' } }]);
    expect(claimValuesOf(entity, 'P999')).toEqual([]);
  });

  it('import しただけでは外部通信しない', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    await import('../scripts/bayes/wikidata-client.mjs');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('BB. Wikidata尤度推定（estimateWikidataLikelihood、scripts/bayes/estimators.mjs）', () => {
  it('単一値: 一致でWIKIDATA_LIKELY_YES・不一致でWIKIDATA_LIKELY_NO', () => {
    expect(estimateWikidataLikelihood({ value: '赤', target: '赤', multi: false })).toBe(WIKIDATA_LIKELY_YES);
    expect(estimateWikidataLikelihood({ value: '青', target: '赤', multi: false })).toBe(WIKIDATA_LIKELY_NO);
  });

  it('単一値: 値が空欄(null/undefined/空文字)ならnull（寄与なし）', () => {
    expect(estimateWikidataLikelihood({ value: null, target: '赤', multi: false })).toBeNull();
    expect(estimateWikidataLikelihood({ value: undefined, target: '赤', multi: false })).toBeNull();
    expect(estimateWikidataLikelihood({ value: '', target: '赤', multi: false })).toBeNull();
  });

  it('複数値(species確認限定用途): 含めばWIKIDATA_LIKELY_YES、含まなくても負信号を出さずnull', () => {
    // PLAN「species版差問題」: P31が多値かつ非一貫なため、不在は「該当しない」の
    // 証拠として使わない（正信号のみの確認限定ソース）。
    expect(estimateWikidataLikelihood({ value: ['人間'], target: '人間', multi: true })).toBe(WIKIDATA_LIKELY_YES);
    expect(estimateWikidataLikelihood({ value: [], target: '人間', multi: true })).toBeNull();
    expect(estimateWikidataLikelihood({ value: null, target: '人間', multi: true })).toBeNull();
    // 配列だが対象値を含まない場合も、classic 16軸の複数値軸(AXIS_MULTI_EXCLUDES=0.2)
    // とは違いnull——他の値を持っていても「人間でない」への負信号にはしない。
    expect(estimateWikidataLikelihood({ value: ['video_game_character'], target: '人間', multi: true })).toBeNull();
  });
});

describe('BB. LLM尤度推定（estimateLlmLikelihood、scripts/bayes/estimators.mjs）', () => {
  it('単一値: verified:trueかつconfidence:highのみ採用。一致でLLM_LIKELY_YES・不一致でLLM_LIKELY_NO', () => {
    expect(estimateLlmLikelihood({ value: 'クール', target: 'クール', multi: false, verified: true, confidence: 'high' })).toBe(
      LLM_LIKELY_YES,
    );
    expect(estimateLlmLikelihood({ value: '元気', target: 'クール', multi: false, verified: true, confidence: 'high' })).toBe(
      LLM_LIKELY_NO,
    );
  });

  it('verified:falseまたはconfidenceがhigh以外ならnull（引用照合ゲート通過分だけを信用する保守設計）', () => {
    expect(estimateLlmLikelihood({ value: 'クール', target: 'クール', multi: false, verified: false, confidence: 'high' })).toBeNull();
    expect(estimateLlmLikelihood({ value: 'クール', target: 'クール', multi: false, verified: true, confidence: 'low' })).toBeNull();
    expect(estimateLlmLikelihood({ value: 'クール', target: 'クール', multi: false, verified: true, confidence: 'none' })).toBeNull();
  });

  it('該当なし/空値はnull（証拠なし経路）', () => {
    expect(estimateLlmLikelihood({ value: '該当なし', target: 'クール', multi: false, verified: true, confidence: 'high' })).toBeNull();
    expect(estimateLlmLikelihood({ value: null, target: 'クール', multi: false, verified: true, confidence: 'high' })).toBeNull();
  });

  it('複数値(roles): 含めばLLM_LIKELY_YES、含まなくても負信号を出さずnull（未列挙は無情報）', () => {
    expect(
      estimateLlmLikelihood({ values: ['姉', '後輩'], target: '姉', multi: true, verified: true, confidence: 'high' }),
    ).toBe(LLM_LIKELY_YES);
    expect(
      estimateLlmLikelihood({ values: ['後輩'], target: '姉', multi: true, verified: true, confidence: 'high' }),
    ).toBeNull();
    expect(estimateLlmLikelihood({ values: [], target: '姉', multi: true, verified: true, confidence: 'high' })).toBeNull();
  });
});

describe('BB. ニコニコ大百科クライアント（scripts/bayes/niconico-client.mjs）', () => {
  it('リクエスト間隔が REQUEST_DELAY_MS 以上あく', async () => {
    vi.useFakeTimers();
    const calledAt: number[] = [];
    const fetchImpl = async () => {
      calledAt.push(Date.now());
      return { ok: true, status: 200, text: async () => '<html></html>' };
    };
    const fetcher = createNiconicoFetcher({ fetchImpl, delayMs: NC_REQUEST_DELAY_MS });

    const done = (async () => {
      await fetcher('/a/a');
      await fetcher('/a/b');
    })();
    await vi.advanceTimersByTimeAsync(2 * NC_REQUEST_DELAY_MS);
    await done;

    expect(calledAt).toHaveLength(2);
    expect(calledAt[1] - calledAt[0]).toBeGreaterThanOrEqual(NC_REQUEST_DELAY_MS);
  });

  it('User-Agent ヘッダを送り、連絡手段を含む', async () => {
    const seen: Array<{ headers?: Record<string, string> }> = [];
    const fetchImpl = async (_url: string, init?: { headers?: Record<string, string> }) => {
      seen.push(init ?? {});
      return { ok: true, status: 200, text: async () => '' };
    };
    const fetcher = createNiconicoFetcher({ fetchImpl, delayMs: 0 });
    await fetcher('/a/test');
    expect(seen[0].headers?.['User-Agent']).toBe(NC_USER_AGENT);
    expect(NC_USER_AGENT).toMatch(/(mailto:|https?:\/\/|[^\s@]+@[^\s@]+\.[^\s@]+)/);
  });

  it('fetchArticleHtml: /a/<title> をURLエンコードして取得する', async () => {
    let seenUrl = '';
    const fetchImpl = async (url: string) => {
      seenUrl = url;
      return { ok: true, status: 200, text: async () => '<html>本文</html>' };
    };
    const fetcher = createNiconicoFetcher({ fetchImpl, delayMs: 0 });
    const html = await fetchArticleHtml(fetcher, '博麗霊夢');
    expect(seenUrl).toBe(`https://dic.nicovideo.jp/a/${encodeURIComponent('博麗霊夢')}`);
    expect(html).toBe('<html>本文</html>');
  });

  it('fetchArticleHtml: 404はnullを返す（存在しない記事はエラーではなく無データ扱い）', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, text: async () => '' });
    const fetcher = createNiconicoFetcher({ fetchImpl, delayMs: 0 });
    expect(await fetchArticleHtml(fetcher, '存在しない記事')).toBeNull();
  });

  it('fetchArticleHtml: 404以外のエラーは例外にする', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, text: async () => '' });
    const fetcher = createNiconicoFetcher({ fetchImpl, delayMs: 0 });
    await expect(fetchArticleHtml(fetcher, 'x')).rejects.toThrow(/status=500/);
  });

  it('extractRedirectPath: location.replace(...)からパスを取り出す。リダイレクトでなければnull', () => {
    const stub =
      '<script>location.replace(\'https://dic.nicovideo.jp/a/%E3%82%B9%E3%82%AB%E3%82%A2%E3%83%8F\');</script>';
    expect(extractRedirectPath(stub)).toBe(`/a/${encodeURIComponent('スカアハ')}`);
    expect(extractRedirectPath('<p>普通の記事本文</p>')).toBeNull();
  });

  it('fetchArticleHtml: 表記ゆれリダイレクトスタブに当たったら転送先を自動で1回追う', async () => {
    const seenPaths: string[] = [];
    const stub =
      '<script>location.replace(\'https://dic.nicovideo.jp/a/%E3%82%B9%E3%82%AB%E3%82%A2%E3%83%8F\');</script>';
    const fetchImpl = async (url: string) => {
      const path = new URL(url).pathname;
      seenPaths.push(path);
      if (path === `/a/${encodeURIComponent('スカサハ')}`) return { ok: true, status: 200, text: async () => stub };
      if (path === `/a/${encodeURIComponent('スカアハ')}`) return { ok: true, status: 200, text: async () => '<p>本物の記事本文</p>' };
      return { ok: false, status: 404, text: async () => '' };
    };
    const fetcher = createNiconicoFetcher({ fetchImpl, delayMs: 0 });
    const html = await fetchArticleHtml(fetcher, 'スカサハ');
    expect(html).toBe('<p>本物の記事本文</p>');
    expect(seenPaths).toEqual([`/a/${encodeURIComponent('スカサハ')}`, `/a/${encodeURIComponent('スカアハ')}`]);
  });

  it('fetchArticleHtml: リダイレクト先が404ならnullを返す', async () => {
    const stub =
      '<script>location.replace(\'https://dic.nicovideo.jp/a/%E5%AD%98%E5%9C%A8%E3%81%97%E3%81%AA%E3%81%84\');</script>';
    const fetchImpl = async (url: string) => {
      const path = new URL(url).pathname;
      if (path === `/a/${encodeURIComponent('元記事')}`) return { ok: true, status: 200, text: async () => stub };
      return { ok: false, status: 404, text: async () => '' };
    };
    const fetcher = createNiconicoFetcher({ fetchImpl, delayMs: 0 });
    expect(await fetchArticleHtml(fetcher, '元記事')).toBeNull();
  });

  it('htmlToText: script/styleの中身は本文に含めず、タグを剥がしてブロック要素は改行にする', () => {
    const html =
      '<html><head><style>.a{color:red}</style><script>alert(1)</script></head><body><p>こんにちは</p><p>さようなら</p></body></html>';
    const text = htmlToText(html);
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('alert');
    expect(text).toContain('こんにちは');
    expect(text).toContain('さようなら');
  });

  it('htmlToText: HTML実体参照をデコードする', () => {
    expect(htmlToText('<p>A&amp;B &lt;tag&gt; &quot;quote&quot; &#39;apos&#39;&nbsp;end</p>')).toBe(
      'A&B <tag> "quote" \'apos\' end',
    );
  });

  it('htmlToText: リンク化された語(<a>等の残りのインライン要素)を除去してもスペースを挿入しない', () => {
    // 2026-07-25、touhou-suwakoの実地抽出で発覚: ニコニコ大百科はほぼ全ての固有名詞を
    // <a>でリンク化するため、除去時にスペースへ変換すると「あーうー」のような
    // 「」で囲まれたリンク付き語の内側に「 あーうー 」という余計なスペースが入り、
    // LLMが返す装飾無しの引用と照合基準文字列がズレて偽陰性になっていた。
    expect(htmlToText('<p>「<a href="/a/x">あーうー</a>」と言う。</p>')).toBe('「あーうー」と言う。');
    expect(htmlToText('<p><a href="/a/x">博麗</a><a href="/a/y">霊夢</a>は巫女。</p>')).toBe('博麗霊夢は巫女。');
  });

  it('htmlToText: td/thの区切りも改行として扱う(表データが連結しない)', () => {
    expect(htmlToText('<table><tr><td>A</td><td>B</td></tr></table>')).toBe('A B');
  });

  it('htmlToText: コメント欄(「ななしのよっしん」以降)を切り捨てる', () => {
    const html = '<p>本文の性格は明るい。</p><p>ななしのよっしん 2026/01/01 なんか適当なコメント 高評価 1</p>';
    expect(htmlToText(html)).toBe('本文の性格は明るい。');
  });

  it('htmlToText: マーカーが無ければ何も切り捨てない', () => {
    expect(htmlToText('<p>マーカーを含まない普通の記事本文</p>')).toBe('マーカーを含まない普通の記事本文');
  });

  it('normalizeWhitespace: 空白ラン(改行/タブ含む)を単一空白へ畳み前後をtrimする', () => {
    expect(normalizeWhitespace('a   b\n\nc\td')).toBe('a b c d');
    expect(normalizeWhitespace('  前後の空白  ')).toBe('前後の空白');
  });

  it('import しただけでは外部通信しない', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    await import('../scripts/bayes/niconico-client.mjs');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('BB. Ollamaクライアント（scripts/bayes/ollama-client.mjs）', () => {
  it('/api/chat へ think:false・format・temperature:0・seed・messages(system+user)を送る', async () => {
    let seenUrl = '';
    let seenBody: Record<string, unknown> = {};
    const fetchImpl = async (url: string, init?: { body?: string }) => {
      seenUrl = url;
      seenBody = JSON.parse(init?.body ?? '{}');
      return { ok: true, status: 200, json: async () => ({ message: { role: 'assistant', content: '{"value":"クール"}' } }), text: async () => '' };
    };
    const chat = createOllamaClient({ fetchImpl, apiRoot: 'http://localhost:11434' });
    const format = { type: 'object', properties: {} };
    await chat({ model: 'qwen3:8b', systemPrompt: 'sys', userPrompt: 'user', format, seed: 42 });

    expect(seenUrl).toBe('http://localhost:11434/api/chat');
    expect(seenBody.model).toBe('qwen3:8b');
    expect(seenBody.think).toBe(false);
    expect(seenBody.stream).toBe(false);
    expect(seenBody.format).toEqual(format);
    expect(seenBody.options).toEqual({ temperature: 0, seed: 42 });
    expect(seenBody.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' },
    ]);
  });

  it('応答のmessage.contentをJSONとしてパースして返す', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message: { content: '{"value":"元気","quote":"根拠"}' } }),
      text: async () => '',
    });
    const chat = createOllamaClient({ fetchImpl });
    const result = await chat({ model: 'qwen3:8b', systemPrompt: '', userPrompt: '', format: {}, seed: 1 });
    expect(result).toEqual({ value: '元気', quote: '根拠' });
  });

  it('<think>タグが混入していても剥がしてからパースする（防御的実装。実地確認では出現しないが将来変化に備える）', () => {
    expect(stripThinkTags('<think>考え中...</think>{"value":"クール"}')).toBe('{"value":"クール"}');
    expect(stripThinkTags('{"value":"クール"}')).toBe('{"value":"クール"}');
  });

  it('ok:false のレスポンスはエラーにする', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' });
    const chat = createOllamaClient({ fetchImpl });
    await expect(chat({ model: 'qwen3:8b', systemPrompt: '', userPrompt: '', format: {}, seed: 1 })).rejects.toThrow(/status=500/);
  });

  it('応答contentがJSONとして解釈できない場合はエラーにする', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message: { content: 'これはJSONではない' } }),
      text: async () => '',
    });
    const chat = createOllamaClient({ fetchImpl });
    await expect(chat({ model: 'qwen3:8b', systemPrompt: '', userPrompt: '', format: {}, seed: 1 })).rejects.toThrow(/JSON/);
  });

  it('import しただけでは外部通信しない', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    await import('../scripts/bayes/ollama-client.mjs');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('BB. evidence-first LLM抽出+引用照合ゲート（scripts/bayes/llm-extract.mjs、PLAN「P5b」の本命部分）', () => {
  function minimalAxisEnums() {
    return {
      personality: ['クール', '元気'],
      mood: ['甘め', '支配的'],
      species: ['人間', '魔族', '不死'],
      combat: ['戦う', '戦わない'],
      distance: ['積極的', '中立'],
      affiliationKind: ['学生', '社会人'],
      roles: ['主従', '姉', '後輩'],
    };
  }
  type SingleAxisGuess = { quote: string; value: string; confidence: string };
  type CombinedGuess = {
    personality: SingleAxisGuess;
    mood: SingleAxisGuess;
    species: SingleAxisGuess;
    combat: SingleAxisGuess;
    distance: SingleAxisGuess;
    affiliationKind: SingleAxisGuess;
    roles: SingleAxisGuess[];
  };
  const NONE: SingleAxisGuess = { quote: '', value: '該当なし', confidence: 'none' };
  function allNone(overrides: Partial<CombinedGuess> = {}): CombinedGuess {
    return {
      personality: NONE,
      mood: NONE,
      species: NONE,
      combat: NONE,
      distance: NONE,
      affiliationKind: NONE,
      roles: [],
      ...overrides,
    };
  }

  it('deriveAxisEnums: questions.jsonのaxis-typeソースから軸ごとの列挙値を出現順で導出する（llm対象外の軸・非axisソースは無視）', () => {
    const questionsFile = {
      questions: [
        { sources: [{ type: 'axis', axis: 'personality', value: 'クール', multi: false }] },
        { sources: [{ type: 'axis', axis: 'personality', value: '元気', multi: false }] },
        { sources: [{ type: 'axis', axis: 'hairColor', value: '赤', multi: false }] },
        { sources: [{ type: 'danbooru-binary', tag: 'smile' }] },
        { sources: [{ type: 'axis', axis: 'roles', value: '姉', multi: true }] },
      ],
    };
    const enums = deriveAxisEnums(questionsFile);
    expect(enums.personality).toEqual(['クール', '元気']);
    expect(enums.roles).toEqual(['姉']);
    expect(enums.mood).toEqual([]);
    expect(enums).not.toHaveProperty('hairColor');
  });

  it('buildUserPrompt: 各軸の選択肢と記事本文を含む', () => {
    const axisEnums = { ...minimalAxisEnums(), mood: [], species: [], combat: [], distance: [], affiliationKind: [] };
    const prompt = buildUserPrompt('本文テキスト', axisEnums);
    expect(prompt).toContain('クール/元気');
    expect(prompt).toContain('本文テキスト');
    expect(prompt).toContain('personality');
  });

  it('verifyQuote: 空白の差異を正規化して照合し、最低長未満/空/未実在の引用は不採用にする', () => {
    const articleText = normalizeWhitespace('霊夢は   とても\n強気な性格。');
    expect(verifyQuote(articleText, 'とても  強気な性格')).toBe(true); // quote側の空白ラン差異も正規化される
    expect(verifyQuote(articleText, '存在しない一節です')).toBe(false);
    expect(verifyQuote(articleText, '短い')).toBe(false); // MIN_QUOTE_LENGTH未満
    expect(verifyQuote(articleText, '')).toBe(false);
  });

  it('stripWrappingBrackets: 前後に対応する「」『』が1組あれば剥がす。無ければそのまま', () => {
    expect(stripWrappingBrackets('「本文の一節」')).toBe('本文の一節');
    expect(stripWrappingBrackets('『本文の一節』')).toBe('本文の一節');
    expect(stripWrappingBrackets('本文の一節')).toBe('本文の一節'); // 括弧が無ければそのまま
    expect(stripWrappingBrackets('「本文中『入れ子』の一節」')).toBe('本文中『入れ子』の一節'); // 外側1組だけ剥がす
    expect(stripWrappingBrackets('「前後で対応していない』')).toBe('「前後で対応していない』'); // 対応してなければ剥がさない
  });

  it('verifyQuote: qwen3が付け足しがちな「」『』での装飾を剥がしてから照合する（本文自体には元々その装飾は無い実例）', () => {
    // 2026-07-25、touhou-reimuの実地抽出でプロンプト上「装飾を追加するな」と
    // 明記してもqwen3が引用を「」で包む癖が直らなかった実例に基づく
    // （本文に実在する一節を「」で包んで渡すとfalseになるが、剥がせば本物と判定できる）。
    const articleText = normalizeWhitespace('霊夢は普段から愛されいむと呼ばれることがある。');
    expect(verifyQuote(articleText, '「普段から愛されいむ」')).toBe(true);
    expect(verifyQuote(articleText, '普段から愛されいむ')).toBe(true); // 装飾が無くても引き続き通る
    expect(verifyQuote(articleText, '「存在しない一節です」')).toBe(false); // 装飾を剥がしても本文に無ければ不採用
  });

  it('実在する引用は採用される(verified:true)。全軸一発で通ればリトライは発生しない', async () => {
    const articleText = normalizeWhitespace('主人に忠実に仕える。人間ではなく魔族である。');
    const ollamaChat = vi.fn().mockResolvedValueOnce(
      allNone({
        species: { quote: '人間ではなく魔族である', value: '魔族', confidence: 'high' },
        roles: [{ quote: '主人に忠実に仕える', value: '主従', confidence: 'high' }],
      }),
    );

    const result = await extractOneCharacter({ ollamaChat, articleText, axisEnums: minimalAxisEnums() });

    expect(result.axes.species).toEqual({ value: '魔族', verified: true, confidence: 'high' });
    expect(result.axes.roles).toEqual({ values: ['主従'], verified: true, confidence: 'high' });
    expect(result.axes.personality).toEqual({ value: '該当なし', verified: false, confidence: 'none' });
    expect(ollamaChat).toHaveBeenCalledTimes(1);
  });

  it('幻覚引用（原文に実在しない）はリトライされ、原文実在の引用に修正されれば採用される', async () => {
    const articleText = normalizeWhitespace('種族は不死である。');
    const ollamaChat = vi
      .fn()
      .mockResolvedValueOnce(allNone({ species: { quote: 'このキャラは吸血鬼です', value: '不死', confidence: 'high' } }))
      .mockResolvedValueOnce({ quote: '種族は不死である', value: '不死', confidence: 'high' });

    const result = await extractOneCharacter({ ollamaChat, articleText, axisEnums: minimalAxisEnums() });

    expect(result.axes.species).toEqual({ value: '不死', verified: true, confidence: 'high' });
    expect(ollamaChat).toHaveBeenCalledTimes(2);
    const speciesLog = result.verification.filter((v: { axis: string }) => v.axis === 'species');
    expect(speciesLog).toEqual([
      { axis: 'species', quote: 'このキャラは吸血鬼です', matched: false, retries: 0 },
      { axis: 'species', quote: '種族は不死である', matched: true, retries: 1 },
    ]);
  });

  it('MAX_LLM_RETRIES(2回)まで再プロンプトしても幻覚引用のままならverified:falseで確定し、valueは信用しない扱いになる', async () => {
    const articleText = normalizeWhitespace('本文には性格の記述が無い。');
    const hallucinated = { quote: '存在しない引用文その1', value: 'クール', confidence: 'high' };
    const ollamaChat = vi
      .fn()
      .mockResolvedValueOnce(allNone({ personality: hallucinated }))
      .mockResolvedValueOnce({ quote: '存在しない引用文その2', value: 'クール', confidence: 'high' })
      .mockResolvedValueOnce({ quote: '存在しない引用文その3', value: 'クール', confidence: 'high' });

    const result = await extractOneCharacter({ ollamaChat, articleText, axisEnums: minimalAxisEnums() });

    expect(result.axes.personality).toEqual({ value: 'クール', verified: false, confidence: 'high' });
    expect(ollamaChat).toHaveBeenCalledTimes(3); // 初回 + retry×2
    const retries = result.verification.filter((v: { axis: string }) => v.axis === 'personality').map((v: { retries: number }) => v.retries);
    expect(retries).toEqual([0, 1, 2]);
  });

  it('該当なし(confidence:none)は照合を試みずverified:falseのまま。リトライもしない', async () => {
    const articleText = '関係ない文章。';
    const ollamaChat = vi.fn().mockResolvedValueOnce(allNone());

    const result = await extractOneCharacter({ ollamaChat, articleText, axisEnums: minimalAxisEnums() });

    for (const key of ['personality', 'mood', 'species', 'combat', 'distance', 'affiliationKind'] as const) {
      expect(result.axes[key]).toEqual({ value: '該当なし', verified: false, confidence: 'none' });
    }
    expect(result.axes.roles).toEqual({ values: [], verified: false, confidence: 'none' });
    expect(ollamaChat).toHaveBeenCalledTimes(1);
  });

  it('roles(複数値): confidence:highかつ引用実在するものだけ採用し、それ以外は静かに落とす（未列挙は無情報という設計のためリトライしない）', async () => {
    const articleText = normalizeWhitespace('幼馴染として育った。姉のように慕われている。');
    const ollamaChat = vi.fn().mockResolvedValueOnce(
      allNone({
        roles: [
          { quote: '幼馴染として育った', value: '主従', confidence: 'high' }, // 実在するがvalueが選択肢外の例は別テストで扱う想定なのでここは主従で揃える
          { quote: '存在しない引用', value: '後輩', confidence: 'high' }, // 幻覚→不採用
          { quote: '姉のように慕われている', value: '姉', confidence: 'low' }, // 実在するがconfidence低→不採用
        ],
      }),
    );

    const result = await extractOneCharacter({ ollamaChat, articleText, axisEnums: minimalAxisEnums() });

    expect(result.axes.roles).toEqual({ values: ['主従'], verified: true, confidence: 'high' });
    expect(ollamaChat).toHaveBeenCalledTimes(1);
  });

  it('import しただけでは外部通信しない', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    await import('../scripts/bayes/llm-extract.mjs');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
